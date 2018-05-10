#!/usr/bin/env node
import fs from 'fs';
import sh from 'shorthash';
import pTry from 'p-try';
import yargs from 'yargs';
import puppeteer from 'puppeteer';


function handleError({extra}, error) {
    if (error instanceof Error && !extra.includes('traceback')) {
        error = error.message;
    }
    console.error(error);
    return (error && error.exitCode) || 1;
}

const mainCommand = {
    command: '$0',

    builder: yargs => yargs
        .option('username', {
            type: 'string',
            alias: 'u',
            description: 'Username',
            demandOption: true,
        })
        .option('password', {
            type: 'string',
            alias: 'p',
            description: 'Password',
            demandOption: true,
        })
        .option('extra', {
            type: 'x',
            array: true,
            hidden: true,
            default: [],
            description: 'Extra, undocumented options',
        }),

    handler: (argv) => (
        pTry(() => main(argv))
            .catch(handleError.bind(null, argv))
            .then(exitCode => exitCode || 0)
            .then(process.exit)
    ),
};

void (
    yargs.command(mainCommand)
        .help()
        .version()
        .argv
);

const baseUrl = 'https://www.sodexobeneficios.com.br';

async function main(options) {
    const {
        extra,
        username,
        password,
    } = options;

    const headless = !extra.includes('headful');

    const browser = await puppeteer.launch({headless});
    const cardsAndTransactions = {};
    try {
        const page = await browser.newPage();

        const loginUrl = `${baseUrl}/sodexo-club/login/`;

        console.log('Logging in...');
        await page.goto(loginUrl);

        const loginFormSelector = 'form#form-login';

        const usernameInput = await page.waitForSelector(`${loginFormSelector} input[name="cpfEmail"]`);
        await usernameInput.type(username, {delay: 48});

        const passwordInput = await page.waitForSelector(`${loginFormSelector} input[name="password"]`);
        await passwordInput.type(password, {delay: 48});

        const submitBtn = await page.waitForSelector(`${loginFormSelector} button[type="submit"]`);

        try {
            await Promise.all([
                submitBtn.click(),
                waitForNetworkIdle(page, {globalTimeout: 3000}),
            ]);
        } catch (e) {
            // Ignore...
        }

        const cardStatementLink = await page.waitForSelector('#cards .info-card-holder .card-balance-link');

        try {
            await Promise.all([
                cardStatementLink.click(),
                waitForNetworkIdle(page, {globalTimeout: 3000}),
            ]);
        } catch (e) {
            // Ignore...
        }

        const cardSelect = await page.waitForSelector('select#selectCard');

        const responses = [];
        const onResponse = async (response) => {
            const data = await response.json().catch(() => null);
            if (data && data.responseData && data.responseStatus === 'success') {
                try {
                    const responseData = JSON.parse(data.responseData);
                    if (!responseData.accountData) {
                        return;
                    }
                    responses.push(responseData.accountData);
                } catch (e) {
                    // Ignore...
                }
            }
        };

        page.on('response', onResponse);

        const cardOptions = await cardSelect.$$('option[data-product]');
        for (let i = 0; i < cardOptions.length; i++) {
            console.log(`Fetching card data: ${i + 1} of ${cardOptions.length}...`);

            const comboBtn = await page.waitForSelector('.card-select span#card-select.sod_select');
            await comboBtn.click();

            const itemBtn = await page.waitForSelector(`.card-select .sod_list .sod_option:nth-child(${i + 2})`);
            await itemBtn.click();

            const submitBtn = await page.waitForSelector('#buttonConsult');
            await Promise.all([
                submitBtn.click(),
                waitForNetworkIdle(page),
            ]);

            const periodSelectBtn = await page.waitForSelector('#period-select');
            await periodSelectBtn.click();

            const periodBtn = await page.waitForSelector('#period-select .sod_list .sod_option:last-child');
            await Promise.all([
                await periodBtn.click(),
                waitForNetworkIdle(page),
            ]);
        }

        responses.forEach(r => {
            if (!r.length || r.length !== 1) {
                return;
            }

            const s = r[0];
            if (!s.cardNumber) {
                return;
            }

            cardsAndTransactions[s.cardNumber] = s.transactionData.map(t => {
                const {
                    date,
                    hour: unsafeHour,
                    balance,
                    description,
                    codeAuthorization,
                    indicatorTransaction,
                } = t;

                const hour = (
                    unsafeHour.length === 8 ? unsafeHour
                        // XXX turns 80:30:2 into 08:03:02, and 0:: into 00:00:00
                        : unsafeHour.replace(':', '').padStart(8).match(/.{1,2}/g).join(':')
                );

                const idString = (
                    codeAuthorization ? codeAuthorization
                        : [date, hour, description.trim()].join(':')
                );

                return {
                    id: sh.unique(idString),
                    date: new Date(`${new Date(`${date}T${hour}Z`).toGMTString()}-03`),
                    memo: description.trim(),
                    amount: balance * ({'-': -1, '+': 1}[indicatorTransaction.trim()]),
                };
            });
        });
    } finally {
        await browser.close();
    }

    Object.keys(cardsAndTransactions).forEach(cardNumber => {
        const charges = cardsAndTransactions[cardNumber];
        const ofx = generateOfx(charges);
        fs.writeFileSync(`./sodexo-${sh.unique(cardNumber)}.ofx`, ofx);
    });
}

async function waitForNetworkIdle(page, {timeout = 500, requests = 0, globalTimeout = null} = {}) {
    return await new Promise((resolve, reject) => {
        const deferred = [];
        const cleanup = () => deferred.reverse().forEach(fn => fn());
        const cleanupAndReject = (err) => cleanup() || reject(err);
        const cleanupAndResolve = (val) => cleanup() || resolve(val);

        if (globalTimeout === null) {
            globalTimeout = page._defaultNavigationTimeout;
        }

        const globalTimeoutId = setTimeout(
            cleanupAndReject,
            globalTimeout,
            new Error('Waiting for network idle timed out')
        );

        deferred.push(() => {
            clearTimeout(globalTimeoutId);
        });

        let inFlight = 0;
        let timeoutId = setTimeout(cleanupAndResolve, timeout);

        deferred.push(() => clearTimeout(timeoutId));

        const onRequest = () => {
            ++inFlight;
            if (inFlight > requests) {
                clearTimeout(timeoutId);
            }
        };

        const onResponse = () => {
            if (inFlight === 0) {
                return;
            }
            --inFlight;
            if (inFlight <= requests) {
                timeoutId = setTimeout(cleanupAndResolve, timeout);
            }
        };

        page.on('request', onRequest);
        page.on('requestfailed', onResponse);
        page.on('requestfinished', onResponse);

        deferred.push(() => {
            page.removeListener('request', onRequest);
            page.removeListener('requestfailed', onResponse);
            page.removeListener('requestfinished', onResponse);
        });
    });
}

function ofxItem({id, date, memo, amount}) {
    const timezoneOffset = date.getTimezoneOffset();
    const formattedDate = date.toISOString().split(/\./g, 2)[0].replace(/-/g, '').replace(/T/g, '').replace(/:/g, '');
    return `
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${formattedDate}[${timezoneOffset / 60 * -1}:GMT]
<TRNAMT>${amount}
<FITID>${id}</FITID>
<MEMO>${memo}</MEMO>
</STMTTRN>
`;
}

function generateOfx(charges) {
    return `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>

<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<CCSTMTRS>
<CURDEF>BRL
<CCACCTFROM>
<ACCTID>nubank-ofx-preview
</CCACCTFROM>

<BANKTRANLIST>
${charges.map(ofxItem).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}

sodexo-ofx
==========

Exports Sodexo card data as OFX.


Disclaimer
----

We have no association of any kind with the SODEXO company.

Also, this is still in the earliest of the earlier days of development. Use it at your own risk. 


Installation
----

```
git clone https://github.com/ravishi/sodexo-ofx
cd sodexo-ofx
npm install
```


Usage
----

Inside the main directory, run:

```
npm start -- --username="<your-username>" --password="<your-password>"
```

This will hopefully generate an `.ofx` file containing the transactions for the latest 90 days for each card you have in your account.

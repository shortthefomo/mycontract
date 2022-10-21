const { XrplClient } = require('xrpl-client')
const lib = require('xrpl-accountlib')
const{ flagNames } = require('flagnames')
const HotPocket = require('hotpocket-js-client')
const fs = require('fs')
const dotenv = require('dotenv')

async function clientApp() {
    dotenv.config()
    const keyFile = 'user.key';
    if (!fs.existsSync(keyFile)) {
        const newKeyPair = await HotPocket.generateKeys()
        const saveData = Buffer.from(newKeyPair.privateKey).toString('hex')
        fs.writeFileSync(keyFile, saveData)
        console.log('New key pair generated.')
    }

    // Generate the key pair using saved private key data.
    const savedPrivateKeyHex = fs.readFileSync(keyFile).toString()
    const userKeyPair = await HotPocket.generateKeys(savedPrivateKeyHex)
    const client = await HotPocket.createClient(['wss://localhost:8081'], userKeyPair)

    // Establish HotPocket connection.
    if (!await client.connect()) {
        console.log('Connection failed.')
        return
    }

    console.log("HotPocket Connected.")
    console.log("Fetch contracts")

    await client.submitContractInput(JSON.stringify({ key: 'sendClientsSigners' }))

    client.on(HotPocket.events.contractOutput, async (result) => {
        console.log("Received outputs:")
        for (let index = 0; index < result.outputs.length; index++) {
            const element = result.outputs[index]
            const response = JSON.parse(element)
            console.log('recieved accounts', response)
            updateSigners(response.signers, client)
        }
    })
}

const updateSigners = async(accounts, client) => {
    console.log('env', 'wss://hooks-testnet-v2.xrpl-labs.com')
    const xrpl = new XrplClient('wss://hooks-testnet-v2.xrpl-labs.com')

    const {account_objects} = await xrpl.send({
        'command': 'account_objects',
        account: process.env.XRPL_SOURCE_ACCOUNT
    })
    let updated = false
    if ('SignerList' in account_objects) {
        updated = await updateSignerList(accounts, xrpl)
    }
    else {
        updated = await createSignerList(accounts, xrpl)
    }
    if (updated) {
        await client.submitContractInput(JSON.stringify({ key: 'walletSignersSet' }))
    }
    xrpl.close()
    
    return false
}

const createSignerList = async (accounts, xrpl) => {
    console.log('createSignerList')
    
    
    //address r4DosiqK2PYcemac4ySY9B8VXP8aRzABbP
    const secret = process.env.XRPL_SOURCE_ACCOUNT_SECRET
    const master = lib.derive.familySeed(secret)

    const {account_data} = await xrpl.send({
        'command': 'account_info',
        account: master.address
    })
    console.log(flagNames(account_data.LedgerEntryType, account_data.Flags))
    console.log('account_data', account_data)

    const {account_objects} = await xrpl.send({
        'command': 'account_objects',
        account: master.address
    })
    const payload = {
        TransactionType: 'SignerListSet',
        Account: master.address,
        Fee: '10',
        Sequence: account_data.Sequence,
        SignerQuorum: 3,
        SignerEntries: [{
            SignerEntry: {
                Account: accounts[0],
                SignerWeight: 1
            }
        }, 
        {
            SignerEntry: {
                Account: accounts[1],
                SignerWeight: 1
            }
        },
        {
            SignerEntry: {
                Account: accounts[2],
                SignerWeight: 1
            }
        }]
    }
    console.log('payload', payload)
    console.log('payload.SignerEntries', payload.SignerEntries)
    const {signedTransaction} = lib.sign(payload, master)
    const result = await xrpl.send({
        command: 'submit',
        tx_blob: signedTransaction
    })
    console.log('result', result)
    
    if (result.engine_result == 'tesSUCCESS') { return true }
    return false
}

const updateSignerList = async (accounts, xrpl) => {
    console.log('updateSignerList')
    
    //address r4DosiqK2PYcemac4ySY9B8VXP8aRzABbP
    const secret = process.env.XRPL_SOURCE_ACCOUNT_SECRET
    const master = lib.derive.familySeed(secret)

    const {account_data} = await xrpl.send({
        'command': 'account_info',
        account: master.address
    })
    console.log(flagNames(account_data.LedgerEntryType, account_data.Flags))
    console.log('account_data', account_data)

    const {account_objects} = await xrpl.send({
        'command': 'account_objects',
        account: master.address
    })
    const payload = {
        TransactionType: 'SignerListSet',
        Account: master.address,
        Fee: String((3 + 1) * 10), // (n +1) * fee
        Sequence: account_data.Sequence,
        SignerQuorum: 3,
        SignerEntries: [{
            SignerEntry: {
                Account: accounts[0],
                SignerWeight: 1
            }
        }, 
        {
            SignerEntry: {
                Account: accounts[1],
                SignerWeight: 1
            }
        },
        {
            SignerEntry: {
                Account: accounts[2],
                SignerWeight: 1
            }
        }]
    }
    console.log('payload', payload)
    console.log('payload.SignerEntries', payload.SignerEntries)
    const {signedTransaction} = lib.sign(payload, master)
    const result = await xrpl.send({
        command: 'submit',
        tx_blob: signedTransaction
    })
    console.log('result', result)
    
    if (result.engine_result == 'tesSUCCESS') { return true }
    return false
}

clientApp()
'use strict'

const HotPocket = require('hotpocket-nodejs-contract')
const lib = require('xrpl-accountlib')
const axios = require('axios')
const stats = require('stats-analysis')
const decimal = require('decimal.js')
const { XrplClient } = require('xrpl-client')

const Binance = class Binance {
    async get() {
        try {
            const data = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT')
            const XrpUsd = Number(data.data?.price) || undefined
            console.log(`Calling, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}
const Bitstamp = class Bitstamp {
    async get() {
        try {
            const data = await axios.get('https://www.bitstamp.net/api/v2/ticker/xrpusd/')
            const XrpUsd = Number(data.data.last) || undefined
            // console.log(`axios get: `, data)
            console.log(`Calling, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const Kraken = class Kraken {
    async get() {
        try {
            const data = await axios.get('https://api.kraken.com/0/public/Ticker?pair=XRPUSD')
            // console.log(data.data)
            const XrpUsd = Number(data.data?.result?.XXRPZUSD?.c[0]) || undefined
            console.log(`Calling, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const Providers = {
    class: { Bitstamp, Kraken, Binance },
    instances: {}
}

const aggregator = (async () => {
    // console.log(`we are in test ${param}`)
    Object.assign(Providers.instances, Object.keys(Providers.class).reduce((a, providerKey) => {
        Object.assign(a, {
            [providerKey]: new Providers.class[providerKey]
        })
        return a
    }, {}))

    const results = await Promise.all(Object.keys(Providers.instances).map(async instanceName => {
        console.log(`  - Getting from ${instanceName}`)
        const data = await Providers.instances[instanceName].get()
        console.log(`     - Got data from ${instanceName}`)
        return data
    }))

    const rawResultsNamed = results.reduce((a, b, i) => {
        Object.assign(a, {
            [Object.keys(Providers.instances)[i]]: b
        })
        return a
    }, {})

    const rawResults = results.reduce((a, b) => a.concat(b), [])
    const rawMedian = stats.median(rawResults)
    const rawStdev = stats.stdev(rawResults)

    const raw = {
        rawResultsNamed,
        rawResults,
        rawMedian,
        rawStdev
    }

    console.log(raw)

    const filteredResults = rawResults.filter(r => Math.abs(r - rawMedian) < rawStdev)
    const filteredMedian = stats.median(filteredResults)
    const filteredMean = stats.mean(filteredResults)

    const filtered = {
        filteredResults,
        filteredMedian,
        filteredMean
    }

    console.log(filtered)

    return {
        ...raw,
        ...filtered
    }
})

const mycontract = async (ctx) => {
    // Your smart contract logic.

    const hpconfig = await ctx.getConfig()
    // console.log('hpconfig.enviroment', hpconfig)
    // console.log('XRPL_SOURCE_ACCOUNT', process.env.XRPL_SOURCE_ACCOUNT)

    for (const user of ctx.users.list()) {
        console.log("User public key", user.publicKey)
        // Loop through inputs sent by the user.
        for (const input of user.inputs) {
            const buffer = await ctx.users.read(input)
            const message = buffer.toString()
            console.log("Received input:", message)

            if (message == 'Fetch Price') {
                const client = new XrplClient(process.env.ENDPOINT)

                const data = await aggregator()
                console.log('XRPL_SOURCE_ACCOUNT', process.env.XRPL_SOURCE_ACCOUNT)
                console.log('GOT DATA', data)

                let Signed = null                
                const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })

                if ('error' in account_data) {
                    console.log('ACCOUNT DATA ERROR', account_data.error)
                    return 
                }

                const Tx = {
                    TransactionType: 'TrustSet',
                    Account: process.env.XRPL_SOURCE_ACCOUNT,
                    Fee: '10',
                    Flags: 131072,
                    LimitAmount: {
                        currency: 'USD',
                        issuer: process.env.XRPL_DESTINATION_ACCOUNT,
                        value: new decimal(data.filteredMedian).toFixed(8)
                    },
                    Sequence: account_data.Sequence,
                    Memos: [{
                        Memo: {
                            MemoData: Buffer.from(JSON.stringify(data.rawResultsNamed), 'utf-8').toString('hex').toUpperCase(),
                            MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
                            MemoType: Buffer.from('rates:' + JSON.stringify(data.rawResults), 'utf-8').toString('hex').toUpperCase()
                        }
                    }]
                }

                console.log('SIGN & SUBMIT')
                try {
                    const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
                    const {signedTransaction} = lib.sign(Tx, keypair)
                    Signed = await client.send({ command: 'submit', 'tx_blob': signedTransaction })
                    console.log({ Signed })
                } catch (e) {
                    console.log(`Error signing / submitting: ${e.message}`)
                }

                console.log('WRAP UP')
                process.exit(0)
            }
            user.send(`Thanks for talking to me!`)
        }
    }
}

const hpc = new HotPocket.Contract()
hpc.init(mycontract)
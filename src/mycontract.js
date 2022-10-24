const HotPocket = require("hotpocket-nodejs-contract")
const EventEmitter = require("events")
const axios = require('axios')
const datasetEmitter = new EventEmitter()
const lib = require('xrpl-accountlib')
const { XrplClient } = require('xrpl-client')
const fs = require('fs')
const stats = require('stats-analysis')
const decimal = require('decimal.js')
const collection = {}

// Collects messages for the desired round and returns the results.
const getDataset = (collection, desiredRoundName, desiredCount, timeout) => {
    return new Promise((resolve) => {
        const collected = []

        // Fire up the timeout if we didn't receive enough messages.
        const timer = setTimeout(() => resolve(collection[desiredRoundName]), timeout)

        datasetEmitter.on(desiredRoundName, () => {
            // Resolve immediately if have have the required no. of messages.
            if (collection[desiredRoundName].length === desiredCount || desiredCount == 0) {
                clearTimeout(timer)
                resolve(collection[desiredRoundName])
            }
        })
    })
}

const multiNplContract = async (ctx) => {
    if (ctx.readonly) { return }
    const familySeed = await accountSetup(ctx)
    const unlSize = ctx.unl.count()
    const hpconfig = await ctx.getConfig()
    const timeoutMs = 1000 // Math.ceil(hpconfig.consensus.roundtime / 2)
    const time = new Date().getTime()
    const providers = Object.keys(Providers.class).reduce((a, providerKey) => {
        return a.concat(new Providers.class[providerKey])
    }, [])

    const min = 0
    const max = Object.keys(Providers.class).length - 1

    ctx.unl.onMessage((node, msg) => {
        const { roundName, data } = JSON.parse(msg.toString())

        if (!(roundName in collection)) {
            collection[roundName] = []
        }
        collection[roundName].push(data)
        datasetEmitter.emit(roundName)
    })

    const walletStateFile = '../' + ctx.publicKey + '-walletState.json'
    if (!fs.existsSync(walletStateFile)) {
        fs.writeFileSync(walletStateFile, JSON.stringify({'multiSigReady': false}))
    }
    await walletSignersSet(ctx, walletStateFile)
    const multiSigReady = JSON.parse(fs.readFileSync(walletStateFile).toString()).multiSigReady

    // console.log('providers', providers)
    // console.log('timeoutMs', timeoutMs)

    // console.log('Providers.instances', Providers.instances)
    const random = Math.floor(Math.random() * (max - min + 1)) + min
    console.log('random', providers[random])

    // let data = await timedFetch(providers[random], timeoutMs)
    let data = await providers[random].get()
    console.log('fetch done..', new Date().getTime() - time)



    // NPL round 1
    // Subscribe to round 1 messages and then send our message for round 1.
    const promise1 = getDataset(collection, 'round1', unlSize, timeoutMs)
    await ctx.unl.send(JSON.stringify({ roundName: 'round1', data: data }))
    const dataset1 = await promise1
    console.log('dataset1', dataset1)

    // NPL round 2
    // Subscribe to round 2 messages and then send our message for round 2.
    const promise2 = getDataset(collection, 'round2', unlSize, timeoutMs)
    await ctx.unl.send(JSON.stringify({ roundName: 'round2', data: familySeed.address }))
    const dataset2 = await promise2
    console.log('dataset2', dataset2)


    const signersEntries = dataset2.reduce((a, b) => {
        a.push({
            SignerEntry: {
                Account: b,
                SignerWeight: 1
            }
        })
        return a
    }, [])
    // console.log('signers', signers)
    sendClientsSigners(ctx, dataset2)
    // console.log('aggregate', aggregate(dataset1))

    if (multiSigReady) {
        const payload = await signContract(familySeed, unlSize, aggregate(dataset1))
        // console.log('payload', payload)
        const promise3 = getDataset(collection, 'round3', unlSize, timeoutMs)
        await ctx.unl.send(JSON.stringify({ roundName: 'round3', data: payload }))
        const dataset3 = await promise3
        console.log('dataset3', dataset3)
        await submitOracleDataToXRPL(payload, dataset3)

    }
}

const accountSetup = async (ctx) => {
    const setupAccount = new Promise((resolve, reject) => {
        // store in ../ as that directory is no part of consensue for hotpocket and not shared across the network
        const keyFile = '../' + ctx.publicKey + '-key.json'
        if (!fs.existsSync(keyFile)) {
            const familySeed = lib.generate.familySeed()
            const data = JSON.stringify(familySeed)
            fs.writeFileSync(keyFile, data)
            console.log('New key pair generated.')
            resolve(familySeed)
        }

        const rawdata = fs.readFileSync(keyFile).toString()
        const accountData = JSON.parse(rawdata)
        // derive the object again as needed references are lost when converted to JSON
        resolve(lib.derive.familySeed(accountData.secret.familySeed))
    })
    return await setupAccount
}
const submitOracleDataToXRPL = async (payload, signatures) => {
    const client = new XrplClient(process.env.ENDPOINT)
    try {
        const signersEntries = signatures.reduce((a, b) => {
            a.push({
                signedTransaction: b
            })
            return a
        }, [])
        const { signedTransaction } = lib.sign(signersEntries)
    
        const result = await client.send({
            command: 'submit',
            tx_blob: signedTransaction
        })
        console.log('result', result)
        console.log('engine_result', result.engine_result)
    } catch (error) {
        console.log('error submitting signed tx', error)
        console.log('payload error', payload)
    }
    
    client.close()
}

const signContract = async (familySeed, unlSize, aggregate) => {
    const client = new XrplClient(process.env.ENDPOINT)

    const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
    // console.log('account_data', account_data)

    const Tx = {
        TransactionType: 'TrustSet',
        Account: process.env.XRPL_SOURCE_ACCOUNT,
        Fee: String((unlSize + 1) * 10), // (n +1) * fee, TODO ~ need to work off base fee returned from the XRPL node instance
        Flags: 131072,
        LimitAmount: {
            currency: 'USD',
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: String(aggregate.filteredMean)
        },
        Sequence: account_data.Sequence,
        Memos: [{
            Memo: {
                MemoData: Buffer.from(JSON.stringify(aggregate.filteredResults), 'utf-8').toString('hex').toUpperCase(),
                MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
                MemoType: Buffer.from('rates:' + JSON.stringify(aggregate.rawResults), 'utf-8').toString('hex').toUpperCase()
            }
        }]
    }
    // console.log('Tx', Tx)

    // console.log('contract address', familySeed.address)
    const { signedTransaction } = lib.sign(Tx, familySeed.signAs(String(familySeed.address)))
    // console.log('signedTransaction', signedTransaction)
    client.close()

    return signedTransaction
}

const walletSignersSet = async (ctx, walletStateFile) => {
    for (const user of ctx.users.list()) {
        // Loop through inputs sent by the user.
        for (const input of user.inputs) {
            const buffer = await ctx.users.read(input)
            try {
                const action = JSON.parse(buffer.toString()).key
                if (action == 'walletSignersSet') {
                    fs.writeFileSync(walletStateFile, JSON.stringify({'multiSigReady': true}))
                    console.log('Multisign signatures set on wallet')
                }
            } catch(error) {
                console.log('walletSignersSet error', error)
            }
        }
    }
}

const sendClientsSigners = async (ctx, signers) => {
    // need to sort this array as item order are different across
    // the deployed contracts. if not sorted respose will fail consensus.

    const sorted = signers.sort(function (a, b) {
        return ('' + a).localeCompare(b)
    })
    
    for (const user of ctx.users.list()) {
        console.log({signers: sorted})
        // Loop through inputs sent by the user.
        for (const input of user.inputs) {
            const buffer = await ctx.users.read(input)
            try {
                const action = JSON.parse(buffer.toString()).key
                if (action == 'sendClientsSigners') {
                    console.log('sending signers to, public key', user.publicKey)
                    user.send(JSON.stringify({signers: sorted}))
                }
            } catch(error) {
                console.log('sendClientsSigners error', error)
            }
        }
    }
}

const aggregate = (results) => {
    const rawResults = results.filter(function (element) { return element !== undefined }) //.reduce((a, b) => a.concat(b), [])
    const rawMedian = stats.median(rawResults)
    let rawStdev = stats.stdev(rawResults)

    const raw = {
        rawResults,
        rawMedian: new decimal(rawMedian).toFixed(8) * 1,
        rawStdev: new decimal(rawStdev).toFixed(8) * 1
    }

    // console.log(raw)

    // filter fails on a zero value
    if (rawStdev == 0) {
        rawStdev = new decimal(0.00000001).toFixed(8)
    }

    const filteredResults = filter(rawResults, rawMedian, rawStdev)
    const filteredMedian = stats.median(filteredResults)
    const filteredMean = stats.mean(filteredResults)

    const filtered = {
        filteredResults,
        filteredMedian: new decimal(filteredMedian).toFixed(8) * 1,
        filteredMean: new decimal(filteredMean).toFixed(8) * 1
    }

    // console.log(filtered)

    return {
        ...raw,
        ...filtered
    }
}

const filter = (rawResults, rawMedian, rawStdev) => {
    const results = []
    for (let index = 0; index < rawResults.length; index++) {
        const r = new decimal(rawResults[index])
        const m = new decimal(rawMedian)
        const d = new decimal(rawStdev)
        // console.log('r m d', r.toFixed(8) , m.toFixed(8), d.toFixed(8))
        const abs = Math.abs(r.minus(m).toFixed(8))

        // console.log('abs', abs)
        if (new decimal(abs).lessThanOrEqualTo(d.toFixed(8))) {
            results.push(r.toFixed(8) * 1)
        }
    }

    // console.log('results', results)
    return results
}

const Binance = class Binance {
    async get() {
        try {
            const data = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT', { name: 'Binance' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            // console.log(`Binance, result: ${XrpUsd}`)
            const XrpUsd = Number(data?.price) || undefined
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const FTX = class FTX {
    async get() {
        try {
            const data = await axios.get('https://ftx.com/api/markets/XRP_USD', { name: 'FTX' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            // console.log('data', data?.data?.result)
            const XrpUsd = Number(data?.data?.result?.price) || undefined
            // console.log('XrpUsd', XrpUsd)
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
            const data = await axios.get('https://www.bitstamp.net/api/v2/ticker/xrpusd/', { name: 'Bitstamp' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            const XrpUsd = Number(data.data.last) || undefined
            // console.log(`Bitstamp, result: ${XrpUsd}`)
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
            const data = await axios.get('https://api.kraken.com/0/public/Ticker?pair=XRPUSD', { name: 'Kraken' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            // console.log(data.data)
            const XrpUsd = Number(data.data?.result?.XXRPZUSD?.c[0]) || undefined
            // console.log(`Kraken, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const Independentreserve = class Independentreserve {
    async get() {
        try {
            const data = await axios.get('https://api.independentreserve.com/Public/GetMarketSummary?primaryCurrencyCode=xrp&secondaryCurrencyCode=usd', { name: 'Independentreserve' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            // console.log(data?.data)
            const XrpUsd = Number(data?.data?.LastPrice) || undefined
            // console.log(`Kraken, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const Bitso = class Bitso {
    async get() {
        try {
            const data = await axios.get('https://api.bitso.com/v3/ticker/?book=xrp_usd', { name: 'Bitso' }, { timeout: 1000 })
                .catch(err => {
                    return undefined
                })
            // console.log(data?.data)
            const XrpUsd = Number(data?.data?.payload?.last) || undefined
            // console.log(`Kraken, result: ${XrpUsd}`)
            return XrpUsd
        } catch (e) {
            console.log('Error', e.message)
            return undefined
        }
    }
}

const Providers = {
    class: { Bitstamp, Kraken, FTX, Binance, Independentreserve, Bitso },
    instances: {}
}

const hpc = new HotPocket.Contract();
hpc.init(multiNplContract);
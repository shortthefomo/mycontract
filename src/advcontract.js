const HotPocket = require('hotpocket-nodejs-contract')
const lib = require('xrpl-accountlib')
const { XrplClient } = require('xrpl-client')
const fs = require('fs')
const axios = require('axios')
const stats = require('stats-analysis')
const decimal = require('decimal.js')

const Binance = class Binance {
    async get() {
        try {
            const data = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT', { name: 'Binance' }, { timeout: process.env.REST_EXCHANGE_TIMEOUT })
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
const Bitstamp = class Bitstamp {
    async get() {
        try {
            const data = await axios.get('https://www.bitstamp.net/api/v2/ticker/xrpusd/', { name: 'Bitstamp' }, { timeout: process.env.REST_EXCHANGE_TIMEOUT })
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
            const data = await axios.get('https://api.kraken.com/0/public/Ticker?pair=XRPUSD', { name: 'Kraken' }, { timeout: process.env.REST_EXCHANGE_TIMEOUT })
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

const Providers = {
    class: { Bitstamp, Kraken, Binance },
    instances: {}
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

const signContract = async (receipt, familySeed, unlSize) => {
    const client = new XrplClient(process.env.ENDPOINT)

    const { account_data } = await client.send({ command: 'account_info', account: process.env.XRPL_SOURCE_ACCOUNT })
    console.log('account_data', account_data)

    const Tx = {
        TransactionType: 'TrustSet',
        Account: process.env.XRPL_SOURCE_ACCOUNT,
        Fee: String((unlSize + 1) * 10), // (n +1) * fee
        Flags: 131072,
        SignerQuorum: unlSize,
        SignerEntries: receipt.signers,
        LimitAmount: {
            currency: 'USD',
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: String(receipt.filtered.contractsMedian)
        },
        Sequence: account_data.Sequence,
        Memos: [{
            Memo: {
                MemoData: Buffer.from(JSON.stringify(receipt.filtered.valuesNamed), 'utf-8').toString('hex').toUpperCase(),
                MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
                MemoType: Buffer.from('rates:' + JSON.stringify(receipt.filtered.valuesMedian), 'utf-8').toString('hex').toUpperCase()
            }
        }]
    }
    console.log('Tx', Tx)

    // console.log('contract address', familySeed.address)
    const { signedTransaction } = lib.sign(Tx, familySeed.signAs(String(familySeed.address)))
    client.close()

    return signedTransaction
}

const myContract = async (ctx) => {
    if (!ctx.readonly) {
        const familySeed = await accountSetup(ctx)
        const unlSize = ctx.unl.count()
        const hpconfig = await ctx.getConfig()
        // Wait only for half of roundtime.
        const timeoutMs = hpconfig.consensus.roundtime

        const min = 0
        const max = unlSize - 1
        const random = Math.floor(Math.random() * (max - min + 1)) + min

        const aggregator = await aggregateData()

        let aggCompleted = false

        // Start listening to incoming NPL messages before we send ours.
        const consensus = new Promise((resolve, reject) => {
            const contracts = []
            const signers = []

            function getFilteredMedian() {
                const valuesMedian = contracts.reduce((a, b) => a.concat(b.aggregator.filteredMedian), [])
                const valuesNamed = contracts.reduce((a, b) => {
                    // console.log('a', a)
                    // console.log('b', b)

                    Object.assign(a, {
                        [b.pubkey]: b.aggregator.filteredMedian
                    })

                    return a
                }, {})

                const contractsRawMedian = stats.median(valuesMedian)
                const contractsRawStdev = stats.stdev(valuesMedian)
                const contractsResults = filter(valuesMedian, contractsRawMedian, contractsRawStdev)
                const contractsMedian = stats.median(contractsResults)
                // const contractsMean = stats.mean(contractsResults)
                return {
                    valuesMedian,
                    valuesNamed,
                    contractsMedian
                }
            }

            function getMax() {
                const filtered = getFilteredMedian()
                console.log(`Active contracts :`, contracts)
                let max = 0
                for (const contract of contracts) {
                    if (contract.value > max) {
                        max = contract.value
                    }
                }
                return {
                    max,
                    filtered,
                    signers
                }
            }


            let timerCon = setTimeout(() => {
                clearTimeout(timerCon)
                aggCompleted = true
                // If we've received less than what we expect, throw error.
                if (contracts.length < unlSize)
                    reject(`Error generating the random number. ${contracts.length} < ${unlSize}`)
                else
                    resolve(getMax())
            }, Math.ceil(timeoutMs / 2))

            ctx.unl.onMessage((node, msg) => {
                try {
                    if (!aggCompleted) {
                        const obj = JSON.parse(msg.toString())
                        if (obj.key === 'contract') {
                            contracts.push(obj)
                            signers.push({
                                SignerEntry: {
                                    Account: obj.address,
                                    SignerWeight: 1
                                }
                            })
                            if (contracts.length === unlSize) {
                                clearTimeout(timerCon)
                                aggCompleted = true
                                resolve(getMax())
                            }
                        }
                    }
                } catch (error) {
                    console.log('aggCompleted error', error)
                }
            })
        })

        await ctx.unl.send(JSON.stringify({
            key: 'contract',
            value: random,
            address: familySeed.address,
            aggregator: aggregator
        }))

        const receipt = await consensus.catch(error => {
            console.log('Insufficient nodes submitted data, elvis left the building.')
            return
        })
        console.log('receiptreceiptreceipt', receipt)
        console.log('Decided Random No.:', receipt.max)
        console.log('Oracle data:', receipt.filtered)

        console.log('sending payload for signing')
        const payload = await signContract(receipt, familySeed, unlSize)


        let signCompleted = false
        const collectSignatures = new Promise((resolve, reject) => {
            const signatures = []

            let timerSig = setTimeout(() => {
                // console.log('collectSignaters timed out')
                clearTimeout(timerSig)
                signCompleted = true
                // If we've received less than what we expect, throw error.
                if (signatures.length < unlSize)
                    reject(`Insufficient signatures. ${signatures.length} < ${unlSize}`)
                else
                    resolve(signatures)
            }, Math.ceil(timeoutMs))

            ctx.unl.onMessage((node, msg) => {
                if (!signCompleted) {
                    try {
                        const obj = JSON.parse(msg.toString())
                        if (obj.key === 'signed') {
                            const signedTransaction = obj.signedTransaction
                            signatures.push({ signedTransaction })
                            console.log('incomming signedTransaction', signedTransaction)
                            if (signatures.length === unlSize) {
                                console.log('collectSignaters all sig collected')
                                clearTimeout(timerSig)
                                signCompleted = true
                                resolve(signatures)
                            }
                        }
                    } catch (error) {
                        console.log('collectSignaters error', error)
                    }
                }
            })
        })

        await ctx.unl.send(JSON.stringify({
            key: 'signed',
            signedTransaction: payload
        }))

        // hold up a bit... 
        await pause(1000)
        const signatures = await collectSignatures.catch(error => {
            console.log('Insufficient nodes signed, elvis left the building.')
            return
        })

        console.log('signatures', signatures)
        if (signatures!= undefined && signatures.length == unlSize) {
            //todo
        }

        // const active_contract = await activeContract(ctx, contracts, receipt)
        // console.log('active_contract', active_contract)

        // if (active_contract) {
        //     console.log('here we will submit the transaction from the active contract: ' + ctx.publicKey)
        // }
    }
}

const pause = (milliseconds = 500) => {
    return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

const aggregateData = (async () => {
    Object.assign(Providers.instances, Object.keys(Providers.class).reduce((a, providerKey) => {
        Object.assign(a, {
            [providerKey]: new Providers.class[providerKey]
        })
        return a
    }, {}))

    const results = await Promise.all(Object.keys(Providers.instances).map(async instanceName => {
        // console.log(`- Getting from ${instanceName}`)
        const data = await Providers.instances[instanceName].get()
        return data
    }))

    const rawResultsNamed = results.reduce((a, b, i) => {
        if (b !== undefined) {
            Object.assign(a, {
                [Object.keys(Providers.instances)[i]]: b
            })
        }
        return a
    }, {})

    const rawResults = results.filter(function (element) { return element !== undefined }) //.reduce((a, b) => a.concat(b), [])
    const rawMedian = stats.median(rawResults)
    let rawStdev = stats.stdev(rawResults)

    const raw = {
        rawResultsNamed,
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
})

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

const activeContract = (async (ctx, contracts, receipt) => {
    // It is important that the message is the same across all contracts
    // becuase contract come in randomly we sort them!
    const sorted = contracts.sort(function (a, b) {
        return ('' + a.address).localeCompare(b.address)
    })
    for (const user of ctx.users.list()) {
        console.log('User public key', user.publicKey)
        let response = null
        // Loop through inputs sent by the user.
        for (const input of user.inputs) {
            const buffer = await ctx.users.read(input)
            const message = buffer.toString()
            const request = JSON.parse(message)
            console.log('Received input:', request)
            switch (request.key) {
                case 'fetch_contracts':
                    response = JSON.stringify({
                        contracts: sorted,
                        active_contract: sorted[receipt].pubkey
                    })
                    break
            }
        }
        if (response == null) { return false }
        user.send(response)
    }

    return (ctx.publicKey == sorted[receipt].pubkey) ? true : false
})

const hpc = new HotPocket.Contract()
hpc.init(myContract)
import * as crypto from 'crypto'
import { Cipher } from 'crypto'
import * as fs from 'fs'
import { BleAddressType } from '../../types/BleAddressType'
import { DuplicateCache } from './utils'
import { BleAddress } from '../../types/Ble'
import { RangeMap } from './gatt'
import * as path from 'path'

const emptyBuffer = Buffer.alloc(0)

const basePath = "NodeBleLib-storage-dir"


interface BleLtk {
	rand: Buffer
	ediv: number
	ltk: Buffer
}

interface BleLtks {
	mitm: boolean
	sc: boolean
	localLtk: BleLtk
	peerLtk: BleLtk
}

interface BleIrks {
	aes: Cipher
	irk: Buffer
}

interface BleGattBoundingDbs {
	hasAllPrimaryServices: boolean
	allPrimaryServices: RangeMap
	secondaryServices: RangeMap
	primaryServicesByUUID: { [uuid: string]: RangeMap }
	timestamp: number
}

interface BleStorageCacheEntry {
	ltks: { [peerAddress: string]: BleLtks } | null
	irks: { [address: string]: BleIrks } | null
	cccdValues: {
		[peerAddress: string]: {
			[handle: string]: number
		} | null
	} | null
	bondedPeerGattDbs: { [peerAddress: string]: BleGattBoundingDbs } | null
	unbondedPeerGattDbs: DuplicateCache
}

const cache: { [ownAddress: string]: BleStorageCacheEntry} = Object.create(null)

function bufferToHex(buffer: Buffer): string {
	return !buffer ? null : buffer.toString('hex')
}

function fixAddressToPath(address: BleAddress): BleAddress {
	return address.replace(/:/g, '-')
}

function fixAddressFromPath(address: BleAddress): BleAddress {
	return address.replace(/-/g, ':')
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
	return crypto.timingSafeEqual ? crypto.timingSafeEqual(a, b) : a.equals(b)
}

function mkdirRecursive(pathItems: string[]): boolean {
	for (let i = 1; i <= pathItems.length; i++) {
		try {
			const p = path.join.apply(null, pathItems.slice(0, i))
			fs.mkdirSync(p)
		} catch (e) {
			if (e.code == 'EEXIST') continue
			//console.log('mkdirRecursive', pathItems, e)
			return false
		}
	}
	return true
}

function writeFile(pathItems: string[], data: string | Buffer): boolean {
	if (!mkdirRecursive(pathItems.slice(0, -1))) return false

	try {
		fs.writeFileSync(path.join.apply(null, pathItems), data)
	} catch (e) {
		//console.log('writeFileSync', pathItems, data, e)
		return false
	}
	return true
}

function constructAddress(type: BleAddressType, address: BleAddress): BleAddress {
	return (type == 'public' ? '00:' : '01:') + address
}

function storeKeys(ownAddress: BleAddress, peerAddress: BleAddress, mitm: boolean, sc: boolean, irk: Buffer | null, localLtk: Buffer | null, localRand: Buffer | null, localEdiv: number | null, peerLtk: Buffer | null, peerRand: Buffer | null, peerEdiv: number | null): void {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) init(ownAddress)

	const cacheEntry = cache[ownAddress]

	if (irk) {
		const irkRev = Buffer.from(irk)
		irkRev.reverse()
		cacheEntry.irks[peerAddress] = {
			aes: crypto.createCipheriv('AES-128-ECB', irkRev, emptyBuffer),
			irk,
		}
	}

	cacheEntry.ltks[peerAddress] = {
		mitm,
		sc,
		localLtk: !localLtk ? null : {
			rand: localRand,
			ediv: localEdiv,
			ltk: localLtk
		},
		peerLtk: !peerLtk ? null : {
			rand: peerRand,
			ediv: peerEdiv,
			ltk: peerLtk
		}
	}

	/**
	 * key.json: {
	 *   "mitm": "{boolean}",
	 *   "sc": "{boolean}",
	 *   "irk": "{hex}",
	 *   "localLtk": { "ediv": "{integer}", "rand": "{hex}", "ltk": "{hex}" },
	 *   "peerLtk": { "ediv": "{integer}", "rand": "{hex}", "ltk": "{hex}" }
	 * }
	 */
	const json = JSON.stringify({
		mitm,
		sc,
		irk: bufferToHex(irk),
		localLtk: !localLtk ? null : {
			rand: localRand.toString('hex'),
			ediv: localEdiv,
			ltk: localLtk.toString('hex')
		},
		peerLtk: !peerLtk ? null : {
			rand: peerRand.toString('hex'),
			ediv: peerEdiv,
			ltk: peerLtk.toString('hex'),
		}
	})

	if (!writeFile([basePath, ownAddress, 'bonds', peerAddress, 'keys.json'], json)) {
		// TODO: handle writing error
	}
}

function resolveAddress(ownAddress: BleAddress, peerRandomAddress: BleAddress): string | null {
	// input format is tt:aa:aa:aa:bb:bb:bb, where tt is 00 for public and 01 for random, rest is MSB -> LSB
	// returns identity address (or address used during pairing if BD_ADDR field was zero in Identity Address Informamtion) in same format or null

	ownAddress = fixAddressToPath(ownAddress)
	peerRandomAddress = peerRandomAddress.replace(/:/g, '')

	const peerRand = Buffer.alloc(16)
	Buffer.from(peerRandomAddress.substr(2, 6), 'hex').copy(peerRand, 13)
	const hash = Buffer.from(peerRandomAddress.substr(8), 'hex')

	//console.log('Resolving address', ownAddress, peerRandomAddress, peerRand, hash)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}
	const irks = cache[ownAddress].irks
	for (const candidatePeerAddress in irks) {
		//console.log('Testing ', candidatePeerAddress)
		if (timingSafeEqual(irks[candidatePeerAddress].aes.update(peerRand).subarray(13), hash)) {
			//console.log('yes!')
			return fixAddressFromPath(candidatePeerAddress)
		}
	}
	return null
}

function getKeys(ownAddress: BleAddress, peerAddress: BleAddress): BleLtks {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	return cache[ownAddress].ltks[peerAddress]
}

function storeCccd(ownAddress: BleAddress, peerAddress: BleAddress, handle: number, value: number): void {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	const cacheEntry = cache[ownAddress]
	if (!cacheEntry.cccdValues[peerAddress]) {
		cacheEntry.cccdValues[peerAddress] = Object.create(null)
	}
	if (cacheEntry.cccdValues[peerAddress][handle] !== value) {
		cacheEntry.cccdValues[peerAddress][handle] = value
		writeFile([
			basePath,
			ownAddress,
			'bonds',
			peerAddress,
			'gatt_server_cccds',
			("000" + handle.toString(16)).substr(-4) + '.json'
		], JSON.stringify(value))
	}
}

function getCccd(ownAddress: BleAddress, peerAddress: BleAddress, handle: number): number {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	const cacheEntry = cache[ownAddress]

	if (cacheEntry.cccdValues[peerAddress]) {
		return cacheEntry.cccdValues[peerAddress][handle]
	}

	return 0
}

function storeGattCache(ownAddress: BleAddress, peerAddress: BleAddress, isBonded: boolean, obj: BleGattBoundingDbs) {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	obj.timestamp = Date.now()

	const cacheEntry = cache[ownAddress]
	if (isBonded) {
		cacheEntry.bondedPeerGattDbs[peerAddress] = obj
	} else {
		cacheEntry.unbondedPeerGattDbs.add(peerAddress, obj)
	}

	writeFile([basePath, ownAddress, isBonded ? 'bonds' : 'unbonded', peerAddress, 'gatt_client_cache.json'], JSON.stringify(obj))
}

function getGattCache(ownAddress: BleAddress, peerAddress: BleAddress, isBonded: boolean): BleGattBoundingDbs | null {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	const cacheEntry = cache[ownAddress]

	if (isBonded) {
		return cacheEntry.bondedPeerGattDbs[peerAddress] || null
	} else {
		return cacheEntry.unbondedPeerGattDbs.get(peerAddress)
	}
}

function removeBond(ownAddress: BleAddress, peerAddress: BleAddress): void {
	ownAddress = fixAddressToPath(ownAddress)
	peerAddress = fixAddressToPath(peerAddress)

	if (!(ownAddress in cache)) {
		init(ownAddress)
	}

	const cacheEntry = cache[ownAddress]

	let remove = false

	if (peerAddress in cacheEntry.irks) {
		remove = true
		delete cacheEntry.irks[peerAddress]
	}

	if (peerAddress in cacheEntry.ltks) {
		remove = true
		delete cacheEntry.ltks[peerAddress]
	}

	if (peerAddress in cacheEntry.cccdValues) {
		remove = true
		delete cacheEntry.cccdValues[peerAddress]
	}

	if (remove) {
		const bondPath = path.join(basePath, ownAddress, 'bonds', peerAddress)
		function recurseRemove(dirPath) {
			fs.readdirSync(dirPath).forEach(p => {
				const entryPath = path.join(dirPath, p)
				if (fs.lstatSync(entryPath).isDirectory()) {
					recurseRemove(entryPath)
				} else {
					fs.unlinkSync(entryPath)
				}
			})
			fs.rmdirSync(dirPath)
		}
		try {
			recurseRemove(bondPath)
		} catch (e) {
		}
	}
}

function init(ownAddress: BleAddress): void {
	ownAddress = fixAddressToPath(ownAddress)

	if (!(ownAddress in cache)) {
		const cacheEntry: BleStorageCacheEntry = {
			irks: Object.create(null),
			ltks: Object.create(null),
			cccdValues: Object.create(null),
			bondedPeerGattDbs: Object.create(null),
			unbondedPeerGattDbs: new DuplicateCache(50)
		}
		cache[ownAddress] = cacheEntry

		try {
			const dir = path.join(basePath, ownAddress, 'bonds')
			fs.readdirSync(dir).forEach(peerAddress => {
				try {
					// TODO: validate that all buffers are of correct size, ediv is a 16-bit integer etc.
					const keys = JSON.parse(fs.readFileSync(path.join(dir, peerAddress, 'keys.json')).toString())
					if (keys.irk) {
						const irkBuffer = Buffer.from(keys.irk, 'hex')
						const irkBufferRev = irkBuffer
						irkBufferRev.reverse()
						const aes = crypto.createCipheriv('AES-128-ECB', irkBufferRev, emptyBuffer)
						cacheEntry.irks[peerAddress] = {
							aes,
							irk: irkBuffer
						}
					}
					if (keys.localLtk || keys.peerLtk) {
						const obj: BleLtks = {
							mitm: keys.mitm,
							sc: keys.sc,
							localLtk: null,
							peerLtk: null,
						}
						if (keys.localLtk) {
							obj.localLtk = {
								rand: Buffer.from(keys.localLtk.rand, 'hex'),
								ediv: keys.localLtk.ediv,
								ltk: Buffer.from(keys.localLtk.ltk, 'hex')
							}
						}
						if (keys.peerLtk) {
							obj.peerLtk = {
								rand: Buffer.from(keys.peerLtk.rand, 'hex'),
								ediv: keys.peerLtk.ediv,
								ltk: Buffer.from(keys.peerLtk.ltk, 'hex')
							}
						}
						cacheEntry.ltks[peerAddress] = obj
					}
				} catch(e) {
					//console.log('readFileSync', e)
				}

				try {
					const obj = JSON.parse(fs.readFileSync(path.join(dir, peerAddress, 'gatt_client_cache.json')).toString())
					cacheEntry.bondedPeerGattDbs[peerAddress] = obj
				} catch(e) {
					//console.log('readFileSync 2', e)
				}

				try {
					fs.readdirSync(path.join(dir, peerAddress, 'gatt_server_cccds')).forEach(handleFileName => {
						if (/^[a-zA-Z0-9]{4}\.json$/.test(handleFileName)) {
							try {
								const v = JSON.parse(fs.readFileSync(path.join(dir, peerAddress, 'gatt_server_cccds', handleFileName)).toString())
								if (v === 0 || v === 1 || v === 2 || v === 3) {
									if (!cacheEntry.cccdValues[peerAddress]) {
										cacheEntry.cccdValues[peerAddress] = Object.create(null)
									}
									cacheEntry.cccdValues[peerAddress][parseInt(handleFileName, 16)] = v
								}
							} catch(e) {
								//console.log('readFileSync', e)
							}
						}
					})
				} catch(e) {
					//console.log('readdir', e)
				}
			})

		} catch(e) {
			//console.log('readdir', e)
		}

		cacheEntry.unbondedPeerGattDbs.on('remove', peerAddress => {
			try {
				fs.unlinkSync(path.join(basePath, ownAddress, 'unbonded', peerAddress, 'gatt_client_cache.json'))
			} catch(e) {
			}
		})

		try {
			const unbondedGattCaches = []
			const dir = path.join(basePath, ownAddress, 'unbonded')
			fs.readdirSync(dir).forEach(peerAddress => {
				try {
					const obj = JSON.parse(fs.readFileSync(path.join(dir, peerAddress, 'gatt_client_cache.json')).toString())
					unbondedGattCaches.push({peerAddress: peerAddress, obj: obj})
				} catch(e) {
				}
			})
			unbondedGattCaches.sort((a, b) => a.obj.timestamp - b.obj.timestamp)
			unbondedGattCaches.forEach(item => {
				cacheEntry.unbondedPeerGattDbs.add(item.peerAddress, item.obj)
			})
		} catch(e) {
		}

		//console.log(cacheEntry)
	}
}

export default {
	constructAddress,
	storeKeys,
	getKeys,
	resolveAddress,
	storeCccd,
	getCccd,
	storeGattCache,
	getGattCache,
	removeBond,
}

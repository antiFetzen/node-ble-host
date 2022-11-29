/*
 * Requirements for transport:
 * Needs write(Buffer) function
 * Needs 'data' event, where the only parameter of type Buffer is a complete HCI packet
 */

import HciErrors from '../hci-errors'
import { Queue } from './utils'
import { BleAddressTypesValue } from '../../types/BleAddressTypes'
import { EventEmitter } from 'events'


enum HciPackage {
	COMMAND = 0x01,
	ACLDATA = 0x02,
	EVENT = 0x04,
}

enum BleEvents {
	DISCONNECTION_COMPLETE = 0x05,
	ENCRYPTION_CHANGE = 0x08,
	READ_REMOTE_VERSION_INFORMATION_COMPLETE = 0x0c,
	CMD_COMPLETE = 0x0e,
	CMD_STATUS = 0x0f,
	HARDWARE_ERROR = 0x10,
	NUMBER_OF_COMPLETE_PACKETS = 0x13,
	ENCRYPTION_KEY_REFRESH_COMPLETE = 0x30,
	LE_META = 0x3e,

	LE_CONNECTION_COMPLETE = 0x01,
	LE_ADVERTISING_REPORT = 0x02,
	LE_CONNECTION_UPDATE_COMPLETE = 0x03,
	LE_READ_REMOTE_USED_FEATURES_COMPLETE = 0x04,
	LE_LONG_TERM_KEY_REQUEST = 0x05,
	LE_READ_LOCAL_P256_PUBLIC_KEY_COMPLETE = 0x08,
	LE_GENERATE_DHKEY_COMPLETE = 0x09,
	LE_ENHANCED_CONNECTION_COMPLETE = 0x0a,
	LE_PHY_UPDATE_COMPLETE = 0x0c,
	LE_EXTENDED_ADVERTISING_REPORT = 0x0d,
}

enum BleOGF {
	LINK_CTL = 0x01,
	HOST_CTL = 0x03,
	INFO_PARAM = 0x04,
	STATUS_PARAM = 0x05,
	LE_CTL = 0x08	,
}

enum HciCommands {
   DISCONNECT = 0x0006 | (BleOGF.LINK_CTL << 10),
   READ_REMOTE_VERSION_INFORMATION = 0x001d | (BleOGF.LINK_CTL << 10),

   SET_EVENT_MASK = 0x0001 | (BleOGF.HOST_CTL << 10),
   RESET = 0x0003 | (BleOGF.HOST_CTL << 10),

   READ_LOCAL_VERSION_INFORMATION = 0x0001 | (BleOGF.INFO_PARAM << 10),
   READ_BUFFER_SIZE = 0x0005 | (BleOGF.INFO_PARAM << 10),
   READ_BD_ADDR = 0x0009 | (BleOGF.INFO_PARAM << 10),

   READ_RSSI = 0x0005 | (BleOGF.STATUS_PARAM << 10),

   LE_SET_EVENT_MASK = 0x0001 | (BleOGF.LE_CTL << 10),
   LE_READ_BUFFER_SIZE = 0x0002 | (BleOGF.LE_CTL << 10),
   LE_READ_LOCAL_SUPPORTED_FEATURES = 0x0003 | (BleOGF.LE_CTL << 10),
   LE_SET_RANDOM_ADDRESS = 0x0005 | (BleOGF.LE_CTL << 10),
   LE_SET_ADVERTISING_PARAMETERS = 0x0006 | (BleOGF.LE_CTL << 10),
   LE_READ_ADVERTISING_CHANNEL_TX_POWER = 0x0007 | (BleOGF.LE_CTL << 10),
   LE_SET_ADVERTISING_DATA = 0x0008 | (BleOGF.LE_CTL << 10),
   LE_SET_SCAN_RESPONSE_DATA = 0x0009 | (BleOGF.LE_CTL << 10),
   LE_SET_ADVERTISING_ENABLE = 0x000a | (BleOGF.LE_CTL << 10),
   LE_SET_SCAN_PARAMETERS = 0x000b | (BleOGF.LE_CTL << 10),
   LE_SET_SCAN_ENABLE = 0x000c | (BleOGF.LE_CTL << 10),
   LE_CREATE_CONNECTION = 0x000d | (BleOGF.LE_CTL << 10),
   LE_CREATE_CONNECTION_CANCEL = 0x000e | (BleOGF.LE_CTL << 10),
   LE_READ_WHITE_LIST_SIZE = 0x000f | (BleOGF.LE_CTL << 10),
   LE_CLEAR_WHITE_LIST = 0x0010 | (BleOGF.LE_CTL << 10),
   LE_ADD_DEVICE_TO_WHITE_LIST = 0x0011 | (BleOGF.LE_CTL << 10),
   LE_REMOVE_DEVICE_FROM_WHITE_LIST = 0x0012 | (BleOGF.LE_CTL << 10),
   LE_CONNECTION_UPDATE = 0x0013 | (BleOGF.LE_CTL << 10),
   LE_READ_REMOTE_USED_FEATURES = 0x0016 | (BleOGF.LE_CTL << 10),
   LE_START_ENCRYPTION = 0x0019 | (BleOGF.LE_CTL << 10),
   LE_LONG_TERM_KEY_REQUEST_REPLY = 0x001a | (BleOGF.LE_CTL << 10),
   LE_LONG_TERM_KEY_REQUEST_NEGATIVE_REPLY = 0x001b | (BleOGF.LE_CTL << 10),
   LE_READ_SUPPORTED_STATES = 0x001c | (BleOGF.LE_CTL << 10),
   LE_SET_DATA_LENGTH = 0x0022 | (BleOGF.LE_CTL << 10),
   LE_READ_SUGGESTED_DEFAULT_DATA_LENGTH = 0x0023 | (BleOGF.LE_CTL << 10),
   LE_WRITE_SUGGESTED_DEFAULT_DATA_LENGTH = 0x0024 | (BleOGF.LE_CTL << 10),
   LE_READ_LOCAL_P256_PUBLIC_KEY = 0x0025 | (BleOGF.LE_CTL << 10),
   LE_GENERATE_DHKEY = 0x0026 | (BleOGF.LE_CTL << 10),
   LE_READ_MAXIMUM_DATA_LENGTH = 0x002F | (BleOGF.LE_CTL << 10),
   LE_SET_DEFAULT_PHY = 0x0031 | (BleOGF.LE_CTL << 10),
   LE_SET_PHY = 0x0032 | (BleOGF.LE_CTL << 10),
   LE_SET_EXTENDED_ADVERTISING_PARAMETERS = 0x0036 | (BleOGF.LE_CTL << 10),
   LE_SET_EXTENDED_ADVERTISING_ENABLE = 0x0039 | (BleOGF.LE_CTL << 10),
   LE_SET_EXTENDED_SCAN_PARAMETERS = 0x0041 | (BleOGF.LE_CTL << 10),
   LE_SET_EXTENDED_SCAN_ENABLE = 0x0042 | (BleOGF.LE_CTL << 10),
   LE_EXTENDED_CREATE_CONNECTION = 0x0043 | (BleOGF.LE_CTL << 10),
}

enum BleRole {
	MASTER = 0x00,
	SLAVE = 0x01,
}

const EMPTY_BUFFER = Buffer.from([])

interface BlePhy {
	scanType: number
	scanInterval: number
	scanWindow: number
	connIntervalMin: number
	connIntervalMax: number
	connLatency: number
	supervisionTimeout: number
	minCELen: number
	maxCELen: number
}

interface BleAdvertisingSet {
	advertisingHandle: number
	duration: number
	maxExtendedAdvertisingEvents: number
}

function isDisconnectErrorCode(code: HciErrors): boolean {
	switch (code) {
		case HciErrors.CONNECTION_TIMEOUT:
		case HciErrors.REMOTE_USER_TERMINATED_CONNECTION:
		case HciErrors.REMOTE_DEVICE_TERMINATED_CONNECTION_DUE_TO_LOW_RESOURCES:
		case HciErrors.REMOTE_DEVICE_TERMINATED_CONNECTION_DUE_TO_POWER_OFF:
		case HciErrors.CONNECTION_TERMINATED_BY_LOCAL_HOST:
		case HciErrors.UNSUPPORTED_REMOTE_FEATURE:
		case HciErrors.LL_RESPONSE_TIMEOUT:
		case HciErrors.LL_PROCEDURE_COLLISION:
		case HciErrors.INSTANT_PASSED:
		case HciErrors.UNACCEPTABLE_CONNECTION_PARAMETERS:
		case HciErrors.CONNECTION_TERMINATED_DUE_TO_MIC_FAILURE:
		case HciErrors.CONNECTION_FAILED_TO_BE_ESTABLISHED:
			return true
	}

	return false
}

class PacketWriter {
	buf: number[]

	constructor() {
		this.buf = []
	}

	u8(value: number): PacketWriter {
		this.buf.push(value)

		return this
	}

	i8(value: number): PacketWriter {
		this.buf.push(value)

		return this
	}

	u16(value: number): PacketWriter {
		this.buf.push(value & 0xff)
		this.buf.push((value >>> 8) & 0xff)

		return this
	}

	u24(value: number): PacketWriter {
		this.buf.push(value & 0xff)
		this.buf.push((value >>> 8) & 0xff)
		this.buf.push((value >>> 16) & 0xff)

		return this
	}

	u32(value: number): PacketWriter {
		this.buf.push(value & 0xff)
		this.buf.push((value >>> 8) & 0xff)
		this.buf.push((value >>> 16) & 0xff)
		this.buf.push((value >>> 24) & 0xff)

		return this
	}

	bdAddr(value: string): PacketWriter {
		for (let i = 15; i >= 0; i -= 3) {
			this.buf.push(parseInt(value.substr(i, 2), 16))
		}

		return this
	}

	buffer(value: Buffer): PacketWriter {
		for (let i = 0; i < value.length; i++) {
			this.buf.push(value[i])
		}

		return this
	}

	toBuffer(): Buffer {
		return Buffer.from(this.buf)
	}
}

class PacketReader {
	pos: number
	buf: Buffer
	throwFn: () => void | never

	constructor(buffer: Buffer, throwFn: () => void | never = () => {}) {
		this.pos = 0
		this.buf = buffer
		this.throwFn = throwFn
	}

	u8(): number {
		if (this.pos + 1 > this.buf.length) this.throwFn()

		return this.buf[this.pos++]
	}

	i8(): number {
		const value = this.u8()

		return value >= 128 ? value - 256 : value
	}

	u16(): number {
		if (this.pos + 2 > this.buf.length) this.throwFn()

		const value = this.buf[this.pos]
			| (this.buf[this.pos + 1] << 8)
		this.pos += 2

		return value
	}

	u32(): number {
		if (this.pos + 4 > this.buf.length) this.throwFn()

		const value = this.buf[this.pos]
			| (this.buf[this.pos + 1] << 8)
			| (this.buf[this.pos + 2] << 16)
			| (this.buf[this.pos + 3] << 24)
		this.pos += 4

		return value
	}

	bdAddr(): string {
		if (this.pos + 6 > this.buf.length) this.throwFn()

		let str = ''
		for (let i = 5; i >= 0; i--) {
			str += (0x100 + this.buf[this.pos + i]).toString(16).substr(-2).toUpperCase()

			if (i != 0) str += ':'
		}
		this.pos += 6

		return str
	}

	buffer(length: number): Buffer {
		if (this.pos + length > this.buf.length) this.throwFn()

		const value = this.buf.subarray(this.pos, this.pos + length)
		this.pos += length

		return value
	}

	getRemainingBuffer(): Buffer {
		return this.buf.subarray(this.pos)
	}

	getRemainingSize(): number {
		return this.buf.length - this.pos
	}
}

// TODO: define types! if Transport is implemented
// -> defined in Hci Adapter?
class Transport extends EventEmitter {
	write?: (Buffer) => void
}

interface HciAdapterCommand {
	opcode: HciCommands
	callback: HciAdapterSendCommandCallback
	handle: number
	buffer?: Buffer
	ignoreResponse?: boolean
}

interface AlConnectionItem {
	isFirst: boolean
	buffer: Buffer
	// TODO: Not save if function declaration is right?!
	sentCallback: () => void
	// TODO: Not save if function declaration is right?!
	completeCallback: () => void
}

type AclConnectionLeConnectionUpdateCallback = (status: number, interval?: number, latency?: number, timeout?: number) => void

type AclConnectionLeReadRemoteUsedFeaturesCallback = (status: number, low?: number, high?: number) => void

type AclConnectionReadRemoteVersionInformationCallback = (status: number, version?: number, manufacturer?: number, subversion?: number) => void

type AclConnectionEncryptionChangeCallback = (status: number, encryptionEnabled?: number) => void

type AclConnectionLePhyUpdateCallback = (status: number, txPhy?: number, rxPhy?: number) => void

interface AclConnectionIncomingL2CAPBuffer extends Array<Buffer> {
	totalLength?: number
}

class AclConnection extends EventEmitter {
	handle: number
	role: BleRole
	disconnecting: boolean
	leConnectionUpdateCallback: AclConnectionLeConnectionUpdateCallback | null
	leReadRemoteUsedFeaturesCallback: AclConnectionLeReadRemoteUsedFeaturesCallback | null
	readRemoteVersionInformationCallback: AclConnectionReadRemoteVersionInformationCallback | null
	encryptionChangeCallback: AclConnectionEncryptionChangeCallback | null
	lePhyUpdateCallback: AclConnectionLePhyUpdateCallback | null
	incomingL2CAPBuffer: AclConnectionIncomingL2CAPBuffer // [Buffer]
	outgoingL2CAPBuffer: Queue<AlConnectionItem> // [{isFirst, buffer, sentCallback, completeCallback}]
	// TODO: check if correct item type as function?!
	outgoingL2CAPPacketsInController: (() => void)[]

	constructor(handle: number, role: BleRole) {
		super()

		this.handle = handle
		this.role = role
		this.disconnecting = false
		this.leConnectionUpdateCallback = null
		this.leReadRemoteUsedFeaturesCallback = null
		this.readRemoteVersionInformationCallback = null
		this.encryptionChangeCallback = null
		this.lePhyUpdateCallback = null
		this.incomingL2CAPBuffer = []
		this.outgoingL2CAPBuffer = new Queue()
		this.outgoingL2CAPPacketsInController = []
	}
}

type HciAdapterSendCommandCallback = (status: number, r: PacketReader) => void

type HciAdapterConnectionCallback = (
	status: number,
	aclConn?: AclConnection,
	role?: BleRole,
	peerAddressType?: BleAddressTypesValue,
	peerAddress?: string,
	connInterval?: number,
	connLatency?: number,
	supervisionTimeout?: number,
	masterClockAccuracy?: number
) => void

type HciAdapterHardwareErrorCallback = (hardwareCode: number) => void

// TODO: check if working same callback for two different callbacks
// handleLeAdvertisingReport()
// scanCallback(eventType, addressType, address, data, rssi)
type HciAdapterLeAdvertisingReportCallback = (eventType: number, addressType?: BleAddressTypesValue, address?: string, data?: Buffer, rssi?: number) => void

// TODO: check if working same callback for two different callbacks
// handleLeExtendedAdvertisingReport()
// scanCallback(eventType, addressType, address, primaryPhy, secondaryPhy, advertisingSid, txPower, rssi, periodicAdvertisingInterval, directAddressType, directAddress, data)
type HciAdapterLeExtendedAdvertisingReportCallback = (
	eventType: number,
	addressType?: BleAddressTypesValue,
	address?: string,
	primaryPhy?: number,
	secondaryPhy?: number,
	advertisingSid?: number,
	txPower?: number,
	rssi?: number,
	periodicAdvertisingInterval?: number,
	directAddressType?: BleAddressTypesValue,
	directAddress?: string,
	data?: Buffer
) => void

// TODO: check if working same callback for two different callbacks
type HciAdapterScanCallback = HciAdapterLeAdvertisingReportCallback | HciAdapterLeExtendedAdvertisingReportCallback

type HciAdapterStatusDataCallback = (status: number, data?: Buffer) => void

class HciAdapter {
	transport: Transport
	hardwareErrorCallback: HciAdapterHardwareErrorCallback

	isStopped: boolean
	pendingCommand: HciAdapterCommand | null // {opcode, callback, handle, ignoreResponse}
	commandQueue: HciAdapterCommand[] // {opcode, buffer, callback, handle}
	activeConnections: { [key:number]: AclConnection} // {handle -> AclConnection}

	hasSeparateLeAclBuffers: boolean | null
	aclMtu: number
	numFreeBuffers: number

	advCallback: HciAdapterConnectionCallback | null
	connCallback: HciAdapterConnectionCallback | null
	scanCallback: HciAdapterScanCallback | null
	leReadLocalP256PublicKeyCallback: HciAdapterStatusDataCallback | null
	leGenerateDHKeyCallback: HciAdapterStatusDataCallback | null


	constructor(transport: Transport, hardwareErrorCallback: HciAdapterHardwareErrorCallback = () => {}) {
		this.transport = transport
		this.hardwareErrorCallback = hardwareErrorCallback

		this.isStopped = false
		this.pendingCommand = null
		this.commandQueue = []
		this.activeConnections = Object.create(null)

		this.hasSeparateLeAclBuffers = null
		this.aclMtu = 0
		this.numFreeBuffers = 0

		this.advCallback = null
		this.connCallback = null
		this.scanCallback = null
		this.leReadLocalP256PublicKeyCallback = null
		this.leGenerateDHKeyCallback = null

		this.transport.on('data', this.onData);
	}

	reallySendCommand(opcode: HciCommands, buffer: Buffer, callback: HciAdapterSendCommandCallback, handle: number): void | undefined {
		if (this.isStopped) return

		this.pendingCommand = {
			opcode,
			handle,
			callback,
			ignoreResponse: false
		}

		const header = new PacketWriter()
			.u8(HciPackage.COMMAND)
			.u16(opcode)
			.u8(buffer.length)
			.toBuffer()

		this.transport.write(Buffer.concat([header, buffer]))
	}

	sendCommand(opcode: HciCommands, buffer: Buffer, callback: HciAdapterSendCommandCallback, handle: number = null): void | undefined {
		if (this.isStopped) return

		if (handle != 0 && !handle) handle = null

		if (this.pendingCommand != null) {
			this.commandQueue.push({ opcode, buffer, callback, handle })
		} else {
			this.reallySendCommand(opcode, buffer, callback, handle)
		}
	}

	triggerSendPackets(conn?: AclConnection): void | undefined {
		while (this.numFreeBuffers != 0) {
			if (this.isStopped) return

			let handle: number
			let selectedConn: AclConnection
			if (!conn) {
				const candidates = []
				for (let handle in this.activeConnections) {
					if (!(handle in this.activeConnections)) continue

					const c = this.activeConnections[handle]
					if (c.outgoingL2CAPBuffer.getLength() != 0 && !c.disconnecting) candidates.push(handle)
				}

				if (candidates.length === 0) break

				handle = candidates[Math.floor(Math.random() * candidates.length)]
				selectedConn = this.activeConnections[handle]
			} else {
				if (conn.disconnecting) break

				handle = conn.handle
				selectedConn = conn
			}

			const item = selectedConn.outgoingL2CAPBuffer.shift()
			if (!item) break

			--this.numFreeBuffers

			const isFirst = item.isFirst
			const buffer = item.buffer
			selectedConn.outgoingL2CAPPacketsInController.push(item.completeCallback)

			const header = new PacketWriter()
				.u8(HciPackage.ACLDATA)
				.u16((handle & 0xfff) | (isFirst ? 0 : 0x1000))
				.u16(buffer.length)
				.toBuffer()

			this.transport.write(Buffer.concat([header, buffer]))
			if (item.sentCallback) item.sentCallback()
		}
	}

	// TODO: define any types!
	sendData(handle: number, cid: number, data: Buffer, sentCallback: any, completeCallback: any): void | undefined {
		if (this.isStopped) return

		data = Buffer.concat([new PacketWriter().u16(data.length).u16(cid).toBuffer(), data])

		const conn = this.activeConnections[handle]

		for (let i = 0; i < data.length; i += this.aclMtu) {
			const isFirst = i === 0
			const isLast = i + this.aclMtu >= data.length
			const slice = data.subarray(i, isLast ? data.length : i + this.aclMtu)
			conn.outgoingL2CAPBuffer.push({
				isFirst,
				buffer: slice,
				sentCallback: isLast ? sentCallback : null,
				completeCallback: isLast ? completeCallback : null,
			})
		}

		this.triggerSendPackets(conn)
	}

	disconnect(handle: number, reason: number): void {
		this.sendCommand(HciCommands.DISCONNECT, new PacketWriter().u16(handle).u8(reason).toBuffer(), () => {}, handle)
	}

	readRemoteVersionInformation(handle: number, callback: (status: number) => void): void {
		this.sendCommand(HciCommands.READ_REMOTE_VERSION_INFORMATION, new PacketWriter().u16(handle).toBuffer(), (status) => {
			if (status !== 0) {
				callback(status)
			} else {
				this.activeConnections[handle].readRemoteVersionInformationCallback = callback
			}
		}, handle)
	}

	setEventMask(low: number, high: number, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.SET_EVENT_MASK, new PacketWriter().u32(low).u32(high).toBuffer(), callback)
	}

	reset(callback: (status: number) => void): void {
		this.sendCommand(HciCommands.RESET, EMPTY_BUFFER, (status) => {
			if (status === 0) {
				this.activeConnections = Object.create(null)
				this.hasSeparateLeAclBuffers = null
				this.aclMtu = 0
				this.numFreeBuffers = 0
				this.advCallback = null
				this.connCallback = null
				this.scanCallback = null
				this.leReadLocalP256PublicKeyCallback = null
				this.leGenerateDHKeyCallback = null
			}

			callback(status)
		})
	}

	readLocalVersionInformation(callback: (status: number, hciVersion?: number, hciRevision?: number, lmpPalVersion?: number, manufacturerName?: number, lmpPalSubversion?: number) => void): void {
		this.sendCommand(HciCommands.READ_LOCAL_VERSION_INFORMATION, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const hciVersion = r.u8()
				const hciRevision = r.u16()
				const lmpPalVersion = r.u8()
				const manufacturerName = r.u16()
				const lmpPalSubversion = r.u16()

				callback(status, hciVersion, hciRevision, lmpPalVersion, manufacturerName, lmpPalSubversion)
			} else {
				callback(status)
			}
		})
	}

	readBdAddr(callback: (status: number, bdAddr?: string) => {}): void {
		this.sendCommand(HciCommands.READ_BD_ADDR, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const bdAddr = r.bdAddr()
				callback(status, bdAddr)
			} else {
				callback(status)
			}
		})
	}

	readBufferSize(callback: (status: number, aclPacketLength?: number, syncPacketLength?: number, numAclPackets?: number, numSyncPackets?: number) => void): void {
		this.sendCommand(HciCommands.READ_BUFFER_SIZE, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const aclPacketLength = r.u16()
				const syncPacketLength = r.u8()
				const numAclPackets = r.u16()
				const numSyncPackets = r.u16()
				if (this.hasSeparateLeAclBuffers === false && this.aclMtu === 0) {
					this.aclMtu = Math.min(aclPacketLength, 1023) // Linux can't handle more than 1023 bytes
					this.numFreeBuffers = numAclPackets
				}
				callback(status, aclPacketLength, syncPacketLength, numAclPackets, numSyncPackets)
			} else {
				callback(status)
			}
		})
	}

	readRssi(handle: number, callback: (status: number, rssi?: number) => void) {
		this.sendCommand(HciCommands.READ_RSSI, new PacketWriter().u16(handle).toBuffer(), (status, r) => {
			if (status === 0) {
				r.u16() // handle
				const rssi = r.i8()
				callback(status, rssi)
			} else {
				callback(status)
			}
		})
	}

	leSetEventMask(low: number, high: number, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_SET_EVENT_MASK, new PacketWriter().u32(low).u32(high).toBuffer(), callback)
	}

	leReadBufferSize(callback: (status: number, packetLength?: number, numPackets?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_BUFFER_SIZE, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const packetLength = r.u16()
				const numPackets = r.u8()
				if (this.hasSeparateLeAclBuffers === null) {
					this.aclMtu = Math.min(packetLength, 1023) // Linux can't handle more than 1023 bytes
					this.numFreeBuffers = numPackets
				}
				this.hasSeparateLeAclBuffers = packetLength != 0
				callback(status, packetLength, numPackets)
			} else {
				callback(status)
			}
		})
	}

	leReadLocalSupportedFeatures(callback: (status: number, low?: number, high?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_LOCAL_SUPPORTED_FEATURES, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const low = r.u32()
				const high = r.u32()
				callback(status, low, high)
			} else {
				callback(status)
			}
		})
	}

	leSetRandomAddress(randomAddress: string, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_SET_RANDOM_ADDRESS, new PacketWriter().bdAddr(randomAddress).toBuffer(), callback)
	}

	leSetAdvertisingParameters(
		advertisingIntervalMin: number,
		advertisingIntervalMax: number,
		advertisingType: BleAdvertisingType,
		ownAddressType: BleAddressTypesValue,
		peerAddressType: BleAddressTypesValue,
		peerAddress: string,
		advertisingChannelMap: number,
		advertisingFilterPolicy: number,
		callback: HciAdapterSendCommandCallback
	): void {
		const pkt = new PacketWriter()
			.u16(advertisingIntervalMin)
			.u16(advertisingIntervalMax)
			.u8(advertisingType)
			.u8(ownAddressType)
			.u8(peerAddressType)
			.bdAddr(peerAddress)
			.u8(advertisingChannelMap)
			.u8(advertisingFilterPolicy)
			.toBuffer()

		this.sendCommand(HciCommands.LE_SET_ADVERTISING_PARAMETERS, pkt, callback)
	}

	leReadAdvertisingChannelTxPower(callback: (status: number, transmitPowerLevel?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_ADVERTISING_CHANNEL_TX_POWER, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const transmitPowerLevel = r.u8()
				callback(status, transmitPowerLevel)
			} else {
				callback(status)
			}
		})
	}

	leSetAdvertisingData(advertisingData: Buffer, callback: HciAdapterSendCommandCallback): void {
		const pkt = Buffer.alloc(32)
		pkt[0] = advertisingData.length
		advertisingData.copy(pkt, 1)

		this.sendCommand(HciCommands.LE_SET_ADVERTISING_DATA, pkt, callback)
	}

	leSetScanResponseData(scanResponseData: Buffer, callback: HciAdapterSendCommandCallback): void {
		const pkt = Buffer.alloc(32)
		pkt[0] = scanResponseData.length
		scanResponseData.copy(pkt, 1)

		this.sendCommand(HciCommands.LE_SET_SCAN_RESPONSE_DATA, pkt, callback)
	}

	leSetAdvertisingEnable(advertisingEnable: boolean, callback: (status: number) => void, advConnCallback: HciAdapterConnectionCallback): void {
		this.sendCommand(HciCommands.LE_SET_ADVERTISING_ENABLE, new PacketWriter().u8(advertisingEnable ? 1 : 0).toBuffer(), (status) => {
			if (advertisingEnable && status === 0) {
				this.advCallback = advConnCallback
			}
			callback(status)
		})
	}

	leSetScanParameters(leScanType: number, leScanInterval: number, leScanWindow: number, ownAddressType: BleAddressTypesValue, scanningFilterPolicy: number, callback: HciAdapterSendCommandCallback): void {
		const pkt = new PacketWriter()
			.u8(leScanType)
			.u16(leScanInterval)
			.u16(leScanWindow)
			.u8(ownAddressType)
			.u8(scanningFilterPolicy)
			.toBuffer()

		this.sendCommand(HciCommands.LE_SET_SCAN_PARAMETERS, pkt, callback)
	}

	leSetScanEnable(leScanEnable: boolean, filterDuplicates: boolean, reportCallback: HciAdapterScanCallback, callback: (status: number) => void): void {
		const pkt = new PacketWriter()
			.u8(leScanEnable ? 1 : 0)
			.u8(filterDuplicates ? 1 : 0)
			.toBuffer()

		this.sendCommand(HciCommands.LE_SET_SCAN_ENABLE, pkt, (status) => {
			if (status === 0) {
				this.scanCallback = leScanEnable ? reportCallback : null
			}
			callback(status)
		})
	}

	leCreateConnection(leScanInterval: number, leScanWindow: number, initiatorFilterPolicy: number, peerAddressType: BleAddressTypesValue, peerAddress: string, ownAddressType: BleAddressTypesValue, connIntervalMin: number, connIntervalMax: number, connLatency: number, supervisionTimeout: number, minCELen: number, maxCELen: number, callback: (status: number) => void, completeCallback: HciAdapterConnectionCallback): void {
		const pkt = new PacketWriter()
			.u16(leScanInterval)
			.u16(leScanWindow)
			.u8(initiatorFilterPolicy)
			.u8(peerAddressType)
			.bdAddr(peerAddress)
			.u8(ownAddressType)
			.u16(connIntervalMin)
			.u16(connIntervalMax)
			.u16(connLatency)
			.u16(supervisionTimeout)
			.u16(minCELen)
			.u16(maxCELen)
			.toBuffer()

		this.sendCommand(HciCommands.LE_CREATE_CONNECTION, pkt, (status) => {
			if (status === 0) {
				this.connCallback = completeCallback
			}

			callback(status)
		})
	}

	leCreateConnectionCancel(callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_CREATE_CONNECTION_CANCEL, EMPTY_BUFFER, callback)
	}

	leReadWhiteListSize(callback: (status: number, whiteListSize?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_WHITE_LIST_SIZE, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const whiteListSize = r.u8()
				callback(status, whiteListSize)
			} else {
				callback(status)
			}
		})
	}

	leClearWhiteList(callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_CLEAR_WHITE_LIST, EMPTY_BUFFER, callback)
	}

	leAddDeviceToWhiteList(addressType: BleAddressTypesValue, address: string, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_ADD_DEVICE_TO_WHITE_LIST, new PacketWriter().u8(addressType).bdAddr(address).toBuffer(), callback)
	}

	leRemoveDeviceFromWhiteList(addressType: BleAddressTypesValue, address: string, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_REMOVE_DEVICE_FROM_WHITE_LIST, new PacketWriter().u8(addressType).bdAddr(address).toBuffer(), callback)
	}

	leConnectionUpdate(handle: number, intervalMin: number, intervalMax: number, latency: number, timeout: number, minCELen: number, maxCELen: number, callback: AclConnectionLeConnectionUpdateCallback): void {
		const pkt = new PacketWriter()
			.u16(handle)
			.u16(intervalMin)
			.u16(intervalMax)
			.u16(latency)
			.u16(timeout)
			.u16(minCELen)
			.u16(maxCELen)
			.toBuffer()

		this.sendCommand(HciCommands.LE_CONNECTION_UPDATE, pkt, (status) => {
			if (status !== 0) {
				callback(status)
			} else {
				this.activeConnections[handle].leConnectionUpdateCallback = callback
			}
		}, handle)
	}

	leReadRemoteUsedFeatures(handle: number, callback: AclConnectionLeReadRemoteUsedFeaturesCallback): void {
		this.sendCommand(HciCommands.LE_READ_REMOTE_USED_FEATURES, new PacketWriter().u16(handle).toBuffer(), (status) => {
			if (status !== 0) {
				callback(status)
			} else {
				this.activeConnections[handle].leReadRemoteUsedFeaturesCallback = callback
			}
		}, handle)
	}

	leStartEncryption(handle: number, randomNumber: Buffer, ediv: number, ltk: Buffer, statusCallback: (status: number) => void, completeCallback: AclConnectionEncryptionChangeCallback): void {
		const pkt = new PacketWriter()
			.u16(handle)
			.buffer(randomNumber)
			.u16(ediv)
			.buffer(ltk)
			.toBuffer()

		this.sendCommand(HciCommands.LE_START_ENCRYPTION, pkt, (status) => {
			if (status === 0) {
				this.activeConnections[handle].encryptionChangeCallback = completeCallback
			}
			statusCallback(status)
		}, handle)
	}

	leLongTermKeyRequestReply(handle: number, ltk: Buffer, callback: AclConnectionEncryptionChangeCallback): void {
		this.sendCommand(HciCommands.LE_LONG_TERM_KEY_REQUEST_REPLY, new PacketWriter().u16(handle).buffer(ltk).toBuffer(), (status) => {
			// NOTE: Connection_Handle is also sent, but should be redundant
			if (status !== 0) {
				callback(status)
			} else {
				this.activeConnections[handle].encryptionChangeCallback = callback
			}
		}, handle)
	}

	// TODO: RENAME method Nequest -> Request
	leLongTermKeyNequestNegativeReply(handle: number, callback: (status:number) => void): void {
		this.sendCommand(HciCommands.LE_LONG_TERM_KEY_REQUEST_NEGATIVE_REPLY, new PacketWriter().u16(handle).toBuffer(), (status) => {
			// NOTE: Connection_Handle is also sent, but should be redundant
			callback(status)
		}, handle)
	}

	leReadSupportedStates(callback: AclConnectionLeReadRemoteUsedFeaturesCallback): void {
		this.sendCommand(HciCommands.LE_READ_SUPPORTED_STATES, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const low = r.u32()
				const high = r.u32()
				callback(status, low, high)
			} else {
				callback(status)
			}
		})
	}

	leSetDataLength(handle: number, txOctets: number, txTime: number, callback: (status: number, handle: number) => void): void {
		this.sendCommand(HciCommands.LE_SET_DATA_LENGTH, new PacketWriter().u16(handle).u16(txOctets).u16(txTime).toBuffer(), (status) => {
			callback(status, handle)
		})
	}

	leReadSuggestedDefaultDataLength(callback: (status: number, suggestedMaxTxOctets?: number, suggestedMaxTxTime?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_SUGGESTED_DEFAULT_DATA_LENGTH, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const suggestedMaxTxOctets = r.u16()
				const suggestedMaxTxTime = r.u16()
				callback(status, suggestedMaxTxOctets, suggestedMaxTxTime)
			} else {
				callback(status)
			}
		})
	}

	leWriteSuggestedDefaultDataLength(suggestedMaxTxOctets: number, suggestedMaxTxTime: number, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_WRITE_SUGGESTED_DEFAULT_DATA_LENGTH, new PacketWriter().u16(suggestedMaxTxOctets).u16(suggestedMaxTxTime).toBuffer(), callback)
	}

	leReadLocalP256PublicKey(callback: HciAdapterStatusDataCallback): void {
		this.sendCommand(HciCommands.LE_READ_LOCAL_P256_PUBLIC_KEY, EMPTY_BUFFER, (status) => {
			if (status === 0) {
				this.leReadLocalP256PublicKeyCallback = callback
			} else {
				callback(status)
			}
		})
	}

	leGenerateDHKey(remoteP256PublicKey: Buffer, callback: HciAdapterStatusDataCallback): void {
		this.sendCommand(HciCommands.LE_GENERATE_DHKEY, new PacketWriter().buffer(remoteP256PublicKey).toBuffer(), (status) => {
			if (status === 0) {
				this.leGenerateDHKeyCallback = callback
			} else {
				callback(status)
			}
		})
	}

	leReadMaximumDataLength(callback: (status: number, supportedMaxTxOctets?: number, supportedMaxTxTime?: number, supportedMaxRxOctets?: number, supportedMaxRxTime?: number) => void): void {
		this.sendCommand(HciCommands.LE_READ_MAXIMUM_DATA_LENGTH, EMPTY_BUFFER, (status, r) => {
			if (status === 0) {
				const supportedMaxTxOctets = r.u16()
				const supportedMaxTxTime = r.u16()
				const supportedMaxRxOctets = r.u16()
				const supportedMaxRxTime = r.u16()
				callback(status, supportedMaxTxOctets, supportedMaxTxTime, supportedMaxRxOctets, supportedMaxRxTime)
			} else {
				callback(status)
			}
		})
	}

	leSetDefaultPhy(allPhys: number, txPhys: number, rxPhys: number, callback: HciAdapterSendCommandCallback): void {
		this.sendCommand(HciCommands.LE_SET_DEFAULT_PHY, new PacketWriter().u8(allPhys).u8(txPhys).u8(rxPhys).toBuffer(), callback)
	}

	leSetPhy(handle: number, allPhys: number, txPhys: number, rxPhys: number, phyOptions: number, callback: AclConnectionLePhyUpdateCallback): void {
		this.sendCommand(HciCommands.LE_SET_PHY, new PacketWriter().u16(handle).u8(allPhys).u8(txPhys).u8(rxPhys).u16(phyOptions).toBuffer(), (status) => {
			if (status !== 0) {
				callback(status)
			} else {
				this.activeConnections[handle].lePhyUpdateCallback = callback
			}
		})
	}

	leSetExtendedScanParameters(ownAddressType: BleAddressTypesValue, scanningFilterPolicy: number, scanningPhys: number, phyArr: BlePhy[], callback:HciAdapterSendCommandCallback): void {
		const writer = new PacketWriter()
			.u8(ownAddressType)
			.u8(scanningFilterPolicy)
			.u8(scanningPhys)

		let arrPos = 0

		if (scanningPhys & 1) {
			// 1M
			writer.u8(phyArr[arrPos].scanType).u16(phyArr[arrPos].scanInterval).u16(phyArr[arrPos].scanWindow)
			++arrPos
		}
		if (scanningPhys & 4) {
			// Coded PHY
			writer.u8(phyArr[arrPos].scanType).u16(phyArr[arrPos].scanInterval).u16(phyArr[arrPos].scanWindow)
			++arrPos
		}

		this.sendCommand(HciCommands.LE_SET_SCAN_PARAMETERS, writer.toBuffer(), callback)
	}

	leSetExtendedScanEnable(leScanEnable: boolean, filterDuplicates: number, duration: number, period: number, reportCallback: HciAdapterScanCallback, callback: (status: number) => void ): void {
		const pkt = new PacketWriter()
			.u8(leScanEnable ? 1 : 0)
			.u8(filterDuplicates)
			.u16(duration)
			.u16(period)
			.toBuffer()

		this.sendCommand(HciCommands.LE_SET_EXTENDED_SCAN_ENABLE, pkt, (status) => {
			if (status === 0) {
				this.scanCallback = leScanEnable ? reportCallback : null
			}
			callback(status)
		})
	}

	leExtendedCreateConnection(initiatorFilterPolicy: number, ownAddressType: BleAddressTypesValue, peerAddressType: BleAddressTypesValue, peerAddress: string, initiatingPhys: number, phyArr: BlePhy[], callback: (status: number) => void, completeCallback:  HciAdapterConnectionCallback): void {
		const writer = new PacketWriter()
			.u8(initiatorFilterPolicy)
			.u8(ownAddressType)
			.u8(peerAddressType)
			.bdAddr(peerAddress)
			.u8(initiatingPhys)

		let arrPos = 0
		for (let i = 0; i < 3; i++) {
			if (initiatingPhys & (1 << i)) {
				writer
					.u16(phyArr[arrPos].scanInterval)
					.u16(phyArr[arrPos].scanWindow)
					.u16(phyArr[arrPos].connIntervalMin)
					.u16(phyArr[arrPos].connIntervalMax)
					.u16(phyArr[arrPos].connLatency)
					.u16(phyArr[arrPos].supervisionTimeout)
					.u16(phyArr[arrPos].minCELen)
					.u16(phyArr[arrPos].maxCELen)

				++arrPos
			}
		}

		this.sendCommand(HciCommands.LE_EXTENDED_CREATE_CONNECTION, writer.toBuffer(), (status) => {
			if (status === 0) {
				this.connCallback = completeCallback
			}
			callback(status)
		})
	}

	leSetExtendedAdvertisingParameters(advertisingHandle: number, advertisingEventProperties: number, primaryAdvertisingIntervalMin: number, primaryAdvertisingIntervalMax: number, primaryAdvertisingChannelMap: number, ownAddressType: BleAddressTypesValue, peerAddressType: BleAddressTypesValue, peerAddress: string, advertisingFilterPolicy: number, advertisingTxPower: number, primaryAdvertisingPhy: number, secondaryAdvertisingMaxSkip: number, secondaryAdvertisingPhy: number, advertisingSid: number, scanRequestNotificationEnable: number, callback: (status: number, selectedTxPower?: number) => void): void {
		const pkt = new PacketWriter()
			.u8(advertisingHandle)
			.u16(advertisingEventProperties)
			.u24(primaryAdvertisingIntervalMin)
			.u24(primaryAdvertisingIntervalMax)
			.u8(primaryAdvertisingChannelMap)
			.u8(ownAddressType)
			.u8(peerAddressType)
			.bdAddr(peerAddress)
			.u8(advertisingFilterPolicy)
			.i8(advertisingTxPower)
			.u8(primaryAdvertisingPhy)
			.u8(secondaryAdvertisingMaxSkip)
			.u8(secondaryAdvertisingPhy)
			.u8(advertisingSid)
			.u8(scanRequestNotificationEnable)
			.toBuffer()

		this.sendCommand(HciCommands.LE_SET_EXTENDED_ADVERTISING_PARAMETERS, pkt, (status, r) => {
			if (status === 0) {
				const selectedTxPower = r.i8()
				callback(status, selectedTxPower)
			} else {
				callback(status)
			}
		})
	}

	leSetExtendedAdvertisingEnable(enable: number, advertisingSets: BleAdvertisingSet[], callback: HciAdapterConnectionCallback): void {
		const writer = new PacketWriter()
			.u8(enable)
			.u8(advertisingSets.length)

		for (let i = 0; i < advertisingSets.length; i++) {
			const set = advertisingSets[i]
			writer
				.u8(set.advertisingHandle)
				.u16(set.duration)
				.u8(set.maxExtendedAdvertisingEvents)
		}

		this.sendCommand(HciCommands.LE_SET_EXTENDED_ADVERTISING_ENABLE, writer.toBuffer(), (status) => {
			if (status == 0 && enable) {
				// TODO: If multiple sets, multiple callbacks needed
				this.advCallback = callback
			} else {
				callback(status)
			}
		})
	}

	private handleDisconnectionComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		if (status !== 0) return

		const handle = r.u16()
		const reason = r.u8()
		const conn = this.activeConnections[handle]
		if (!conn) return

		delete this.activeConnections[handle]
		this.commandQueue = this.commandQueue.filter(cmd => cmd.handle !== handle)

		if (this.pendingCommand !== null && this.pendingCommand.handle === handle) {
			this.pendingCommand.ignoreResponse = true
		}
		this.numFreeBuffers += conn.outgoingL2CAPPacketsInController.length
		conn.emit('disconnect', reason)
		this.triggerSendPackets()
	}

	private handleEncryptionChange(r: PacketReader): void | undefined {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		const callback = conn.encryptionChangeCallback
		if (callback) {
			conn.encryptionChangeCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			const encryptionEnabled = r.u8()
			callback(status, encryptionEnabled)
		}
	}

	private handleReadRemoteVersionInformationComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		const callback = conn.readRemoteVersionInformationCallback
		if (callback) {
			conn.readRemoteVersionInformationCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			const version = r.u8()
			const manufacturer = r.u16()
			const subversion = r.u16()
			callback(status, version, manufacturer, subversion)
		}
	}

	private handleHardwareError(r: PacketReader): void {
		const hardwareCode = r.u8()
		this.pendingCommand = null
		this.commandQueue = []

		// Rest will be reset when Reset Command is sent
		this.hardwareErrorCallback(hardwareCode)
	}

	private handleNumberOfCompletePackets(r: PacketReader): void {
		const numHandles = r.u8()
		const callbacks = []

		for (let i = 0; i < numHandles; i++) {
			const handle = r.u16()
			let numCompleted = r.u16()
			const conn = this.activeConnections[handle]
			if (!conn) {
				// TODO: Print warning about buggy controller
				continue
			}

			if (numCompleted > conn.outgoingL2CAPPacketsInController.length) {
				// TODO: Print warning about buggy controller
				numCompleted = conn.outgoingL2CAPPacketsInController.length
			}

			this.numFreeBuffers += numCompleted
			callbacks.push(conn.outgoingL2CAPPacketsInController.splice(0, numCompleted))
		}
		for (let i = 0; i < callbacks.length; i++) {
			for (let j = 0; j < callbacks[i].length; j++) {
				if (callbacks[i][j]) callbacks[i][j]()
			}
		}

		this.triggerSendPackets()
	}

	private handleEncryptionKeyRefreshComplete(r: PacketReader): void {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		const callback = conn.encryptionChangeCallback
		if (callback) {
			conn.encryptionChangeCallback = null
			if (status === 0) {
				callback(status, 0x01)
			} else {
				callback(status)
			}
		}
	}

	private handleLeConnectionComplete(r: PacketReader): void | undefined | never {
		const status = r.u8()
		if (status === HciErrors.ADVERTISING_TIMEOUT) {
			let ac = this.advCallback
			this.advCallback = null

			if (ac) ac(status)
		} else if (status !== 0) {
			const cc = this.connCallback
			this.connCallback = null

			if (cc) cc(status)
		} else {
			const handle = r.u16()
			const role = r.u8()
			const peerAddressType = r.u8()
			const peerAddress = r.bdAddr()
			const connInterval = r.u16()
			const connLatency = r.u16()
			const supervisionTimeout = r.u16()
			const masterClockAccuracy = r.u8()

			if (handle in this.activeConnections) {
				// TODO: what to do here?
				throw new Error(`Handle ${handle} already connected!`)
			}

			const aclConn = new AclConnection(handle, role)
			this.activeConnections[handle] = aclConn

			let callback
			if (role === BleRole.MASTER) {
				callback = this.connCallback
				this.connCallback = null
			} else {
				//console.log("slave conn complete " + advCallback)
				callback = this.advCallback
				this.advCallback = null
				if (!callback) {
					// Unexpected, kill this connection
					const reason = 0x13
					this.sendCommand(HciCommands.DISCONNECT, new PacketWriter().u16(handle).u8(reason).toBuffer(), () => {
						// Ignore
					}, handle)

					return
				}
			}

			callback(status, aclConn, role, peerAddressType, peerAddress, connInterval, connLatency, supervisionTimeout, masterClockAccuracy)
		}
	}

	private handleLeAdvertisingReport(r: PacketReader): void {
		if (this.scanCallback) {
			const numReports = r.u8()
			// At least BCM20702A0 can send numReports > 1 but then actually have only one report in the packet,
			// so gracefully abort if the buffer ends early.
			for (let i = 0; i < numReports && r.getRemainingSize() > 0; i++) {
				const eventType = r.u8()
				const addressType = r.u8()
				const address = r.bdAddr()
				const lengthData = r.u8()
				const data = r.buffer(lengthData)
				const rssi = r.i8()

				// TODO: handle different parameter interfaces... :(
				this.scanCallback(eventType, addressType, address, data, rssi)
			}
		}
	}

	private handleLeConnectionUpdateComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		let interval: number
		let latency: number
		let timeout: number

		const callback = conn.leConnectionUpdateCallback
		if (status === 0) {
			interval = r.u16()
			latency = r.u16()
			timeout = r.u16()
		}

		if (callback) {
			conn.leConnectionUpdateCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			callback(status, interval, latency, timeout)
		}
		if (status === 0) {
			conn.emit('connectionUpdate', interval, latency, timeout)
		}
	}

	private handleLeReadRemoteUsedFeaturesComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		const callback = conn.leReadRemoteUsedFeaturesCallback
		if (callback) {
			conn.leReadRemoteUsedFeaturesCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			const low = r.u32()
			const high = r.u32()
			callback(status, low, high)
		}
	}

	private handleLeLongTermKeyRequest(r: PacketReader): void | undefined {
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn || conn.role !== BleRole.SLAVE) return

		const randomNumber = r.buffer(8)
		const ediv = r.u16()
		conn.emit('ltkRequest', randomNumber, ediv)
	}

	private handleLeReadLocalP256PublicKeyComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		const callback = this.leReadLocalP256PublicKeyCallback
		if (callback) {
			this.leReadLocalP256PublicKeyCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			const localP256PublicKey = r.buffer(64)
			callback(status, localP256PublicKey)
		}
	}

	private handleLeGenerateDHKeyComplete(r: PacketReader): void | undefined {
		const status = r.u8()
		const callback = this.leGenerateDHKeyCallback
		if (callback) {
			this.leGenerateDHKeyCallback = null
			if (status !== 0) {
				callback(status)
				return
			}

			const dhKey = r.buffer(32)
			callback(status, dhKey)
		}
	}

	private handleLeEnhancedConnectionComplete(r: PacketReader): void | never {
		const status = r.u8()
		if (status === HciErrors.ADVERTISING_TIMEOUT) {
			const ac = this.advCallback
			this.advCallback = null
			if (ac) ac(status)

		} else if (status !== 0) {
			const cc = this.connCallback
			this.connCallback = null

			if (cc) cc(status)
		} else {
			const handle = r.u16()
			const role = r.u8()
			const peerAddressType = r.u8()
			const peerAddress = r.bdAddr()
			const localResolvablePrivateAddress = r.bdAddr()
			const peerResolvablePrivateAddress = r.bdAddr()
			const connInterval = r.u16()
			const connLatency = r.u16()
			const supervisionTimeout = r.u16()
			const masterClockAccuracy = r.u8()

			if (handle in this.activeConnections) {
				// TODO: what to do here?
				throw new Error(`Handle {$handle} already connected!`)
			}

			const aclConn = new AclConnection(handle, role)
			this.activeConnections[handle] = aclConn

			let callback: HciAdapterConnectionCallback
			if (role === BleRole.MASTER) {
				callback = this.connCallback
				this.connCallback = null
			} else {
				//console.log("slave conn complete " + advCallback)
				callback = this.advCallback
				this.advCallback = null
			}

			// TODO: fix it!!
			callback(status, aclConn, role, peerAddressType, peerAddress, localResolvablePrivateAddress, peerResolvablePrivateAddress, connInterval, connLatency, supervisionTimeout, masterClockAccuracy)
		}
	}

	private handleLePhyUpdateComplete(r: PacketReader): void {
		const status = r.u8()
		const handle = r.u16()
		const conn = this.activeConnections[handle]
		if (!conn) return

		let txPhy: number
		let rxPhy: number
		const callback = conn.lePhyUpdateCallback
		if (status === 0) {
			txPhy = r.u8()
			rxPhy = r.u8()
		}

		if (callback) {
			conn.lePhyUpdateCallback = null
			if (status !== 0) {
				callback(status)
				return
			}
			callback(status, txPhy, rxPhy)
		}

		if (status === 0) {
			conn.emit('connectionUpdate', txPhy, rxPhy)
		}
	}

	private handleLeExtendedAdvertisingReport(r: PacketReader): void {
		if (this.scanCallback) {
			const numReports = r.u8()
			for (let i = 0; i < numReports; i++) {
				const eventType = r.u16()
				const addressType = r.u8()
				const address = r.bdAddr()
				const primaryPhy = r.u8()
				const secondaryPhy = r.u8()
				const advertisingSid = r.u8()
				const txPower = r.i8()
				const rssi = r.i8()
				const periodicAdvertisingInterval = r.u16()
				const directAddressType = r.u8()
				const directAddress = r.bdAddr()
				const lengthData = r.u8()
				const data = r.buffer(lengthData)

				// TODO: fix it!
				this.scanCallback(eventType, addressType, address, primaryPhy, secondaryPhy, advertisingSid, txPower, rssi, periodicAdvertisingInterval, directAddressType, directAddress, data)
			}
		}
	}

	private onData(data: Buffer): void | never {
		function throwInvalidLength(): never {
			throw new Error(`Invalid packet length for ${data.toString('hex')}, ${data}!`)
		}
		if (data.length === 0) throwInvalidLength()

		const r = new PacketReader(data, throwInvalidLength)
		const packetType = r.u8()
		if (packetType === HciPackage.EVENT) {
			if (data.length < 3) throwInvalidLength()

			const eventCode = r.u8()
			const paramLen = r.u8()
			if (paramLen + 3 !== data.length) throwInvalidLength()

			if (eventCode === BleEvents.CMD_COMPLETE || eventCode === BleEvents.CMD_STATUS) {
				let status
				if (eventCode === BleEvents.CMD_STATUS) {
					status = r.u8()
				}
				const numPkts = r.u8()
				const opcode = r.u16()

				if (this.pendingCommand === null || this.pendingCommand.opcode !== opcode) {
					// TODO: ignore? probably command sent by other process
				} else {
					if (eventCode === BleEvents.CMD_COMPLETE) {
						status = r.u8() // All packets we can handle have status as first parameter
					}

					const pc = this.pendingCommand
					this.pendingCommand = null
					if (this.commandQueue.length !== 0) {
						const cmd = this.commandQueue.shift()
						this.reallySendCommand(cmd.opcode, cmd.buffer, cmd.callback, cmd.handle)
					}
					if (pc.callback && !pc.ignoreResponse) {
						pc.callback(status, r)
					}
				}
			} else {
				switch (eventCode) {
					case BleEvents.DISCONNECTION_COMPLETE:
						this.handleDisconnectionComplete(r)
						break
					case BleEvents.ENCRYPTION_CHANGE:
						this.handleEncryptionChange(r)
						break
					case BleEvents.READ_REMOTE_VERSION_INFORMATION_COMPLETE:
						this.handleReadRemoteVersionInformationComplete(r)
						break
					case BleEvents.HARDWARE_ERROR:
						this.handleHardwareError(r)
						break
					case BleEvents.NUMBER_OF_COMPLETE_PACKETS:
						this.handleNumberOfCompletePackets(r)
						break
					case BleEvents.ENCRYPTION_KEY_REFRESH_COMPLETE:
						this.handleEncryptionKeyRefreshComplete(r)
						break
					case BleEvents.LE_META:
						switch(r.u8()) {
						case BleEvents.LE_CONNECTION_COMPLETE:
							this.handleLeConnectionComplete(r)
							break
						case BleEvents.LE_ADVERTISING_REPORT:
							this.handleLeAdvertisingReport(r)
							break
						case BleEvents.LE_CONNECTION_UPDATE_COMPLETE:
							this.handleLeConnectionUpdateComplete(r)
							break
						case BleEvents.LE_READ_REMOTE_USED_FEATURES_COMPLETE:
							this.handleLeReadRemoteUsedFeaturesComplete(r)
							break
						case BleEvents.LE_LONG_TERM_KEY_REQUEST:
							this.handleLeLongTermKeyRequest(r)
							break
						case BleEvents.LE_READ_LOCAL_P256_PUBLIC_KEY_COMPLETE:
							this.handleLeReadLocalP256PublicKeyComplete(r)
							break
						case BleEvents.LE_GENERATE_DHKEY_COMPLETE:
							this.handleLeGenerateDHKeyComplete(r)
							break
						case BleEvents.LE_ENHANCED_CONNECTION_COMPLETE:
							this.handleLeEnhancedConnectionComplete(r)
							break
						case BleEvents.LE_PHY_UPDATE_COMPLETE:
							this.handleLePhyUpdateComplete(r)
							break
						case BleEvents.LE_EXTENDED_ADVERTISING_REPORT:
							this.handleLeExtendedAdvertisingReport(r)
							break
					}
				}
			}
		} else if (packetType === HciPackage.ACLDATA) {
			if (data.length < 5) throwInvalidLength()

			let conhdl = r.u16()
			const pb = (conhdl >> 12) & 0x3
			const bc = (conhdl >> 14) & 0x3
			conhdl &= 0xfff

			const len = r.u16()
			const aclConn = this.activeConnections[conhdl]
			if (aclConn) {
				// TODO: define incommingL2CAPBuffer!
				const ib = aclConn.incomingL2CAPBuffer

				if (pb === 2) {
					// First packet
					if (ib.length !== 0) {
						// Warning: incomplete incoming packet, dropping
						ib.length = 0
					}
					ib.totalLength = 0
					//console.log('first packet')
					if (len < 4) {
						// Possibly invalid on the LL layer, but allow this
						ib.push(r.getRemainingBuffer())
						ib.totalLength += ib[ib.length - 1].length
					} else {
						const l2capLength = (data[5] | (data[6] << 8))
						//console.log('l2capLength: ' + l2capLength + ', len: ' + len)
						if (4 + l2capLength === len) {
							// Full complete packet
							r.u16() // Length
							const cid = r.u16()
							//console.log(`full packet with cid ${ cid}`)
							aclConn.emit('data', cid, r.getRemainingBuffer())
						} else if (4 + l2capLength < len) {
							// Invalid, dropping
						} else if (4 + l2capLength > len) {
							ib.push(r.getRemainingBuffer())
							ib.totalLength += ib[ib.length - 1].length
						}
					}
				} else if (pb === 1) {
					// Continuation
					const buf = r.getRemainingBuffer()
					if (ib.length === 0) {
						// Not a continuation, dropping
					} else {
						if (ib[ib.length - 1].length < 4) {
							ib[ib.length - 1] = Buffer.concat([ib[ib.length - 1], buf])
						} else {
							ib.push(buf)
						}
						ib.totalLength += buf.length
						if (ib.totalLength >= 4) {
							const l2capLength = (ib[0][0] | (ib[0][1] << 8))
							if (4 + l2capLength === ib.totalLength) {
								const completePacket = new PacketReader(Buffer.concat(ib, ib.totalLength))
								completePacket.u16(); // Length
								const cid = completePacket.u16()
								ib.length = 0
								ib.totalLength = 0
								aclConn.emit('data', cid, completePacket.getRemainingBuffer())
							}
						}
					}
				} else {
					// Invalid pb
				}
			}
		} else {
			// Ignore unknown packet type
		}
	}

	stop(): void {
		if (this.isStopped) return

		this.isStopped = true
		this.transport.removeListener('data', this.onData)
		this.transport = {
			write: () => {}
		}
	}

	getAdvCallback(): HciAdapterConnectionCallback {
		return this.advCallback
	}
}

export default function (transport: Transport) {
	return new HciAdapter(transport)
}

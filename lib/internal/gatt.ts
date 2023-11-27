import { AttErrors } from '../att-errors'

const EventEmitter = require('events')
const util = require('util')
const utils = require('./utils')
const Queue = utils.Queue
const serializeUuid = utils.serializeUuid
const AttErrors = require('../att-errors')
const storage = require('./storage')

/**
 * All UUID inputs are required to be either strings in the format `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`, or a 16-bit unsigned integer number (in which case it is assumed to be an UUID in Bluetooth SIG's base range).
 */
type GattUUID = string | number

/**
 * All characteristic and descriptor values that this API **outputs** are always Buffer objects.
 * All value **inputs** may be either Buffers or strings. If the value is a string, it is converted to a Buffer using the UTF-8 encoding.
 * However, the `value` property of characteristics and descriptors is treated differently. See its documentation for more info.
 */
type GattValue = Buffer | string

/**
 * The MTU value is shared with the GATT Client instance. See its documentation for more information.
 */
type GattMtu = unknown


enum BleGattAttribute {
	ERROR_RESPONSE = 0x01,
	EXCHANGE_MTU_REQUEST = 0x02,
	EXCHANGE_MTU_RESPONSE = 0x03,
	FIND_INFORMATION_REQUEST = 0x04,
	FIND_INFORMATION_RESPONSE = 0x05,
	FIND_BY_TYPE_VALUE_REQUEST = 0x06,
	FIND_BY_TYPE_VALUE_RESPONSE = 0x07,
	READ_BY_TYPE_REQUEST = 0x08,
	READ_BY_TYPE_RESPONSE = 0x09,
	READ_REQUEST = 0x0a,
	READ_RESPONSE = 0x0b,
	READ_BLOB_REQUEST = 0x0c,
	READ_BLOB_RESPONSE = 0x0d,
	READ_MULTIPLE_REQUEST = 0x0e,
	READ_MULTIPLE_RESPONSE = 0x0f,
	READ_BY_GROUP_TYPE_REQUEST = 0x10,
	READ_BY_GROUP_TYPE_RESPONSE = 0x11,
	WRITE_REQUEST = 0x12,
	WRITE_RESPONSE = 0x13,
	WRITE_COMMAND = 0x52,
	PREPARE_WRITE_REQUEST = 0x16,
	PREPARE_WRITE_RESPONSE = 0x17,
	EXECUTE_WRITE_REQUEST = 0x18,
	EXECUTE_WRITE_RESPONSE = 0x19,
	HANDLE_VALUE_NOTIFICATION = 0x1b,
	HANDLE_VALUE_INDICATION = 0x1d,
	HANDLE_VALUE_CONFIRMATION = 0x1e,
	SIGNED_WRITE_COMMAND = 0xd2,
}

const BASE_UUID_SECOND_PART = '-0000-1000-8000-00805F9B34FB'

function isKnownRequestOpcode(opcode: number): boolean {
	switch (opcode) {
		case BleGattAttribute.EXCHANGE_MTU_REQUEST:
		case BleGattAttribute.FIND_INFORMATION_REQUEST:
		case BleGattAttribute.FIND_BY_TYPE_VALUE_REQUEST:
		case BleGattAttribute.READ_BY_TYPE_REQUEST:
		case BleGattAttribute.READ_REQUEST:
		case BleGattAttribute.READ_BLOB_REQUEST:
		case BleGattAttribute.READ_MULTIPLE_REQUEST:
		case BleGattAttribute.READ_BY_GROUP_TYPE_REQUEST:
		case BleGattAttribute.WRITE_REQUEST:
		case BleGattAttribute.PREPARE_WRITE_REQUEST:
		case BleGattAttribute.EXECUTE_WRITE_REQUEST:
			return true
		default:
			return false
	}
}

function isKnownResponseOpcode(opcode: number): boolean {
	switch (opcode) {
		case BleGattAttribute.ERROR_RESPONSE:
		case BleGattAttribute.EXCHANGE_MTU_RESPONSE:
		case BleGattAttribute.FIND_INFORMATION_RESPONSE:
		case BleGattAttribute.FIND_BY_TYPE_VALUE_RESPONSE:
		case BleGattAttribute.READ_BY_TYPE_RESPONSE:
		case BleGattAttribute.READ_RESPONSE:
		case BleGattAttribute.READ_BLOB_RESPONSE:
		case BleGattAttribute.READ_MULTIPLE_RESPONSE:
		case BleGattAttribute.READ_BY_GROUP_TYPE_RESPONSE:
		case BleGattAttribute.WRITE_RESPONSE:
		case BleGattAttribute.PREPARE_WRITE_RESPONSE:
		case BleGattAttribute.EXECUTE_WRITE_RESPONSE:
			return true
		default:
			return false
	}
}

function validate(test: boolean, failMsg: string): void | never {
	if (!test) {
		throw new Error(failMsg)
	}
}

function fixCallback(obj: any, callback: (...a: any[]) => any): (...a: any[]) => any {
	validate(!callback || typeof callback === 'function', 'Invalid callback')
	callback = (callback || function() {}).bind(obj)
	return callback
}

function fixUuid(uuid: string | number): string | never {
	if (typeof uuid === 'string' && /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
		return uuid.toUpperCase()
	}
	if (Number.isInteger(uuid as number) && uuid >= 0 && uuid <= 0xffff) {
		return getFullUuid(uuid)
	}
	validate(false, 'Invalid uuid (must be a string on the form 00000000-0000-0000-0000-000000000000 or an integer between 0x0000 and 0xffff)')
}

function writeUuid128(buf: Buffer, uuid: string, pos: number) {
	uuid = uuid.replace(/-/g, '')
	for (let i = 30; i >= 0; i -= 2) {
		buf[pos++] = parseInt(uuid.substr(i, 2), 16)
	}
}

function getFullUuid(v: Buffer | string | number): string | null {
	if (v instanceof Buffer && v.length === 2) {
		v = v[0] | (v[1] << 8)
	}
	if (Number.isInteger(v as number)) {
		return (0x100000000 + (v as number)).toString(16).substr(-8).toUpperCase() + BASE_UUID_SECOND_PART
	} else if (typeof v === 'string') {
		return v.toUpperCase()
	} else if (v instanceof Buffer && v.length === 16) {
		const uuid = Buffer.from(v).reverse().toString('hex').toUpperCase()

		return [
			uuid.substr(0, 8),
			uuid.substr(8, 4),
			uuid.substr(12, 4),
			uuid.substr(16, 4),
			uuid.substr(20, 12)
		].join('-')
	}
	return null
}

enum GattCharacteristicProperty {
	BROADCAST = 'broadcast',
	READ = 'read',
	WRITE_WITHOUT_RESPONSE = 'write-without-response',
	WRITE = 'write',
	NOTIFY = 'notify',
	INDICATE = 'indicate',
	/**
	 * not yet supported
	 */
	AUTHENTICATED_SIGNED_WRITES = 'authenticated-signed-writes',
	RELIABLE_WRITE = 'reliable-write',
	WRITABLE_AUXILIARIES = 'writable-auxiliaries',
}

enum GattCharacteristicPermission {
	NOT_PERMITTED = 'not-permitted',
	OPEN = 'open',
	ENCRYPTED = 'encrypted',
	ENCRYPTED_MITM = 'encrypted-mitm',
	ENCRYPTED_MITM_SC = 'encrypted-mitm-sc',
	CUSTOM = 'custom',
}

interface GattServiceObject { // TODO: merge? with GattServerService?
	isSecondaryService: boolean
	uuid: number | string
	includedServices: unknown[]
	characteristics: GattServerCharacteristics[]
}

interface GattServerServiceIncluded {
	startHandle: number | null
	endHandle: number | null
	uuid: string | null
}


/**
 * This interface describes the set of properties each object item in the `services` array of `gattDb.addServices(services)` must have. All properties are only read and inspected during the service is being added.
 */
interface GattServerService {
	/**
	 * UUID of the service. Mandatory property.
	 */
	uuid: GattUUID

	/**
	 * Whether the service is secondary or primary. Secondary services cannot be discovered directly but are only meant to be included by other services.
	 * Optional property.
	 *
	 * @default false
	 */
	isSecondaryService?: boolean

	/**
	 * Array of included services. Each item is a reference to either a previously added service or one of the services currently being added.
	 ** Optional property.
	 *
	 * @default [] empty array
	 */
	includedServices?: GattServerService[]

	/**
	 * Positive 16-bit unsigned integer of a proposed start handle. If the property exists and the service fits at this position, it will be used. Otherwise it is placed directly after the last current service.
	 * This algorithm is run for each service in the same order as declared in the `services` argument to `gattDb.addServices`.
	 *
	 * Once the service is added, this property will be set to the actual start handle by the stack.
	 *
	 * Optional property.
	 */
	startHandle?: number | null

	/**
	 * This property is never read when the service is added, but is rather just assigned the actual end handle by the stack when the service has been added.
	 *
	 * This can be useful after a change of GATT services in the database, when we need to tell the client about the range of changed handles using the Service Changed Characteristic.
	 */
	endHandle?: number | null

	/**
	 * Array of characteristics.
	 * Optional property.
	 *
	 * @default [] empty array
	 */
	characteristics?: GattServerCharacteristics[]

	// TODO: not described in readme
	// TODO: define unknown
	userObj: unknown // perhaps ServiceObject
	numberOfHandles: number
}

/**
 *
 * This interface describes the set of properties each object item in the array of `service.characteristics` must have.
 *
 * The `uuid`, `properties`, `maxLength`, `readPerm`, `writePerm` and `descriptors` properties are only read and inspected during the service is being added.
 */
interface GattServerCharacteristics {
	/**
	 * UUID of the characteristic. Mandatory property.
	 */
	uuid: GattUUID,

	/**
	 * Defines properties for this characteristic. This can be used by the client to detect the available features for this characteristic.
	 * Optional property.
	 *
	 * @default [] empty array (which would be quite useless)
	 */
	properties?: GattCharacteristicPermission[]

	/**
	 * An integer between 0 and 512 specifying the max length in bytes for this characteristic value.
	 * Optional property.
	 *
	 * @default 512
	 */
	maxLength?: number

	/**
	 * Defines the permission needed to read the characteristic.
	 * Optional property.
	 *
	 * @default `open` if the characteristic has the `read` property, otherwise `not-permitted`
	 */
	readPerm?: GattCharacteristicPermission

	/**
	 * Defines the permission needed to write the characteristic.
	 * Optional property.
	 *
	 * @default `open` if the characteristic has any of the the `write`, `write-without-response`, `reliable-write` properties, otherwise `not-permitted`.
	 */
	writePerm: GattCharacteristicPermission

	/**
	 * Array or descriptors.
	 * Optional property.

	 * @default [] empty array
	 */
	descriptors: GattServerDescriptor[]

	/**
	 * Unless there are custom read and write handlers, the stack will read and write the value from/to this property.
	 *
	 * Upon a write, the type will be preserved (if it previously was a string, a string will be stored, otherwise a buffer will be stored).
	 */
	value: Buffer | string

	/**
	 * This method must be present if `readPerm` is set to `custom` (otherwise it is not used). Upon receiving any kind of request that reads the characteristic, this method will first be invoked to check if the read should be permitted or not.
	 *
	 * If the callback is called with the error code `AttErrors.SUCCESS`, the read is permitted and the read will be performed as usual (unless the connection disconnects before the callback is called). Otherwise the error code will be sent as response to the client.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.READ_NOT_PERMITTED`
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION` (only if bond exists, has LTK, but the link is currently not encrypted)
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE` (only if encrypted)
	 * * `AttErrors.INSUFFICIENT_AUTHENTICATION`
	 * * `AttErrors.INSUFFICIENT_AUTHORIZATION`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @callback callback Callback that should be called with the result
	 * @param error {number} An `AttErrors` result code
	 */
	onAuthorizeRead: (connection: Connection, callback: (error: AttErrors) => void ): void

	/**
	 * This optional method will be used to read the value of the characteristic when a request is received from a client. If it is not present, the stack will simply read the `value` property.
	 *
	 * The `value` should be the current full characteristic value. Depending on request type, it will automatically be sliced depending on request offset and MTU.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @callback callback that should be called with the result
	 * @param error An `AttErrors` result code
	 * @param value The value to send as response, if no error
	 */
	onRead: (connection: Connection, callback: (error: AttErrors, value: Buffer | string | undefined) => void) => void

	/**
	 * This optional method always overrides the `onRead` method and can be used in particular to handle Read Blob Requests in a more specialized way. The callback should be called with the value set to the current full characteristic value, but where the first `offset` bytes have been removed.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.INVALID_OFFSET`
	 * * `AttErrors.ATTRIBUTE_NOT_LONG` (only when offset is not 0)
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @param offset The offset from where the client wants to read
	 * @callback callback that should be called with the result
	 * @param error An `AttErrors` result code
	 * @param value The value to send as response, if no error
	 */
	onPartialRead: (connection: Connection, offset: number, callback: (error: AttErrors, value: Buffer | string | undefined) => void) => void

	/**
	 * This method must be present if `writePerm` is set to `custom` (otherwise it is not used). Upon receiving any kind of request or command that writes the characteristic, this method will first be invoked to check if the write should be permitted or not.
	 *
	 * If the callback is called with the error code `AttErrors.SUCCESS`, the write is permitted and the write will be performed as usual (unless the connection disconnects before the callback is called). Otherwise the error code will be sent as response to the client.
	 *
	 * For Write Requests and Write Without Responses, this method will be called just before the write attempt. For Long Writes and Reliable Writes, this method will be invoked for each received Prepare Write Request. When all Prepare Write Requests have been sent and the writes are later executed, the writes will be performed at once.
	 *
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.WRITE_NOT_PERMITTED`
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION` (only if bond exists, has LTK, but the link is currently not encrypted)
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE` (only if encrypted)
	 * * `AttErrors.INSUFFICIENT_AUTHENTICATION`
	 * * `AttErrors.INSUFFICIENT_AUTHORIZATION`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the write
	 * @callback callback Callback that should be called with the result
	 * @param error An AttErrors result code
	 */
	onAuthorizeWrite: (connection: Connection, callback: (error: AttErrors) => void) => void

	/**
	 * This optional method will be called when a write needs to be done. If this method is not present, the `value` property of the characteristic object is instead updated.
	 *
	 * In case for Prepared Writes, consecutive writes with offsets directly following the previous write to the same value are internally concatenated to the full value at the time the writes are committed. At that time this method will be called only once with the full value.
	 *
	 * The callback must be called when `needsResponse` is true. (Otherwise calling the callback is a NO-OP.)
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.INVALID_OFFSET`
	 * * `AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH`
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * `AttErrors.OUT_OF_RANGE`
	 * * `AttErrors.WRITE_REQUEST_REJECTED`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the write
	 * @param needsResponse Whether a response must be sent
	 * @param value The value to write
	 * @callback callback Callback that should be called with the response, if needed
	 * @param error An AttErrors result code
	 */
	onWrite: (connection: Connection, needsResponse: boolean, value: Buffer, callback: (error: AttErrors) => void) => void

	/**
	 * This optional method always overrides `onWrite`. Same as `onWrite` but can be used to handle the cases where Partial Writes are used where the starting offset in the initial write is not 0. If this happens and only `onWrite` would be present, an `AttErrors.INVALID_OFFSET` error is sent in response by the stack without calling the `onWrite` method.
	 *
	 * @param connection The BLE connection that requests the write
	 * @param needsResponse Whether a response must be sent
	 * @param offset Offset between 0 and 512 where to start the write
	 * @param value The value to write
	 * @callback callback Callback that should be called with the response, if needed
	 * @param error An AttErrors result code
	 */
	onPartialWrite: (connection: Connection, needsResponse: boolean, offset: number, value: Buffer, callback: (error: AttErrors) => void) => void


	/**
	 * Optional method which is invoked each time the client changes the subscription status.
	 *
	 * When the client writes to the Client Characteristic Configuration Descriptor of this characteristic, the `isWrite` argument is true.
	 *
	 * When a client disconnects and previously had either notifications or indications subscribed, this method will be called with the last three arguments set to false.
	 *
	 * When a bonded client connects, the previous CCCD value is read from the storage and if it was subscribed in the previous connection, this method will be called immediately after the connection gets established with the `isWrite` argument set to false.
	 *
	 * @param connection The BLE connection whose GATT client has changed subscription
	 * @param notification Whether the client has registered for notifications
	 * @param indication Whether the client has registered for indications
	 * @param isWrite Whether this was a real write to the CCCD or the change was due to a connection/disconnection
	 */
	onSubscriptionChange: (connection: Connection, notification: boolean, indication: boolean, isWrite: boolean) => void

	/**
	 * This method is attached by the stack to the characteristic object when the service is being added to the GATT db if it has the `notify` property. Calling it will notify the connection's GATT client with the new value. If the client wasn't subscribed, the method will do nothing and return false.
	 *
	 * If there is a pending Exchange MTU Request sent from this device, the notifications will be queued (per specification) and be sent when it completes. Otherwise the packet goes straight to the BLE connection's output buffer. In case you want to write a large amount of packets, you should wait for the `sentCallback` before you write another packet, to make it possible for the stack to interleave other kinds of packets. This does not decrease the throughput, as opposed to waiting for the `completeCallback` between packets.
	 *
	 * The value will be truncated to fit MTU - 3 bytes.
	 *
	 * @param connection The BLE connection whose GATT client will be notified
	 * @param value Value to notify
	 * @param sentCallback A callback when the packet has been sent to the controller
	 * @param completeCallback A callback when the whole packet has been acknowledged by the peer's Link Layer or been flushed due to disconnection of the link
	 * @return Whether the connection's GATT client was subscribed or not
	 */
	notify: (connection: Connection, value: Buffer | string, sentCallback?: () => void , completeCallback?: () => void) => boolean

	/**
	 * This method is attached by the stack to the characteristic object when the service is being added to the GATT db if it has the `notify` property. Calling it will notify all subscribers with the new value. See the `notify` method for more information.
	 *
	 * @param value Value to notify
	 */
	notifyAll: (value: Buffer | string) => void

	/**
	 * This method is attached by the stack to the characteristic object when the service is being added to the GATT db if it has the `indicate` property. Calling it will indicate the connection's GATT client with the new value. If the client wasn't subscribed, the method will do nothing and return false.
	 *
	 * If there already is one or more pending indications or a pending Exchange MTU Request, the value will be enqueued and sent when the previous operations have completed. Otherwise the value is sent straight to the BLE connection's output buffer.
	 *
	 * The value will be truncated to fit MTU - 3 bytes.
	 *
	 * @param connection The BLE connection whose GATT client will be indicated
	 * @param value Value to indicate
	 * @param callback A callback that will be called when the confirmation arrives
	 * @return Whether the connection's GATT client was subscribed or not
	 */
	indicate: (connection: Connection, value: Buffer | string, callback?: () => void) => boolean

	/**
	 * This method is attached by the stack to the characteristic object when the service is being added to the GATT db if it has the `indicate` property. Calling it will indicate all subscribers with the new value. See the `indicate` method for more information. If you need the confirmation from the different connections, use the `indicate` method for each connection.
	 *
	 * @param value Value to indicate
	 */
	indicateAll: (value: Buffer | string) => void


	// TODO: not described in readme
	// TODO: define unknown
	userObj: unknown // perhaps CharacteristicsObject
	startHandle: unknown |null
	endHandle: unknown | null
	cccds: { [id: string]: { connection: Connection, value: number } }
}

/**
 * This interface describes the set of properties each object item in the array of `characteristics.descriptors` must have.
 *
 * The `uuid`, `maxLength`, `readPerm` and `writePerm` properties are only read and inspected during the service is being added.
 *
 * The Characteristic Extended Properties Descriptor is automatically added to a characteristic by the stack, if any declared properties needs it. This descriptor may not be added manually.
 *
 * The Client Characteristic Configuration Descriptor is automatically added to a characteristic by the stack, if the notify or indicate properties are declared. This will have open read and write permissions. If custom write permissions are needed, manually add a custom Client Characteristic Configuration Descriptor with the desired permissions. However, no other than the `uuid`, `writePerm` and `onAuthorizeWrite` properties will be used in this case.
 */
interface GattServerDescriptor {
	/**
	 * UUID of the descriptor. Mandatory property.
	 */
	uuid: GattUUID

	/**
	 * An integer between 0 and 512 specifying the max length in bytes for this characteristic value.
	 * Optional property.
	 *
	 * @default 512
	 */
	maxLength?: number

	/**
	 * Defines the permission needed to read the characteristic.
	 * Optional property.
	 *
	 * @default `open` if the characteristic has the `read` property, otherwise `not-permitted`
	 */
	readPerm?: GattCharacteristicPermission

	/**
	 * Defines the permission needed to write the characteristic.
	 * Optional property.
	 *
	 * @default `open` if the characteristic has any of the the `write`, `write-without-response`, `reliable-write` properties, otherwise `not-permitted`.
	 */
	writePerm: GattCharacteristicPermission

	/**
	 * Unless there are custom read and write handlers, the stack will read and write the value from/to this property.
	 *
	 * Upon a write, the type will be preserved (if it previously was a string, a string will be stored, otherwise a buffer will be stored).
	 */
	value: Buffer | string

	/**
	 * This method must be present if `readPerm` is set to `custom` (otherwise it is not used). Upon receiving any kind of request that reads the characteristic, this method will first be invoked to check if the read should be permitted or not.
	 *
	 * If the callback is called with the error code `AttErrors.SUCCESS`, the read is permitted and the read will be performed as usual (unless the connection disconnects before the callback is called). Otherwise the error code will be sent as response to the client.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.READ_NOT_PERMITTED`
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION` (only if bond exists, has LTK, but the link is currently not encrypted)
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE` (only if encrypted)
	 * * `AttErrors.INSUFFICIENT_AUTHENTICATION`
	 * * `AttErrors.INSUFFICIENT_AUTHORIZATION`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @callback callback Callback that should be called with the result
	 * @param error {number} An `AttErrors` result code
	 */
	onAuthorizeRead: (connection: Connection, callback: (error: AttErrors) => void ): void

	/**
	 * This optional method will be used to read the value of the characteristic when a request is received from a client. If it is not present, the stack will simply read the `value` property.
	 *
	 * The `value` should be the current full characteristic value. Depending on request type, it will automatically be sliced depending on request offset and MTU.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @callback callback that should be called with the result
	 * @param error An `AttErrors` result code
	 * @param value The value to send as response, if no error
	 */
	onRead: (connection: Connection, callback: (error: AttErrors, value: Buffer | string | undefined) => void) => void

	/**
	 * This optional method always overrides the `onRead` method and can be used in particular to handle Read Blob Requests in a more specialized way. The callback should be called with the value set to the current full characteristic value, but where the first `offset` bytes have been removed.
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.INVALID_OFFSET`
	 * * `AttErrors.ATTRIBUTE_NOT_LONG` (only when offset is not 0)
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the read
	 * @param offset The offset from where the client wants to read
	 * @callback callback that should be called with the result
	 * @param error An `AttErrors` result code
	 * @param value The value to send as response, if no error
	 */
	onPartialRead: (connection: Connection, offset: number, callback: (error: AttErrors, value: Buffer | string | undefined) => void) => void

	/**
	 * This method must be present if `writePerm` is set to `custom` (otherwise it is not used). Upon receiving any kind of request or command that writes the characteristic, this method will first be invoked to check if the write should be permitted or not.
	 *
	 * If the callback is called with the error code `AttErrors.SUCCESS`, the write is permitted and the write will be performed as usual (unless the connection disconnects before the callback is called). Otherwise the error code will be sent as response to the client.
	 *
	 * For Write Requests and Write Without Responses, this method will be called just before the write attempt. For Long Writes and Reliable Writes, this method will be invoked for each received Prepare Write Request. When all Prepare Write Requests have been sent and the writes are later executed, the writes will be performed at once.
	 *
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.WRITE_NOT_PERMITTED`
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION` (only if bond exists, has LTK, but the link is currently not encrypted)
	 * * `AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE` (only if encrypted)
	 * * `AttErrors.INSUFFICIENT_AUTHENTICATION`
	 * * `AttErrors.INSUFFICIENT_AUTHORIZATION`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the write
	 * @callback callback Callback that should be called with the result
	 * @param error An AttErrors result code
	 */
	onAuthorizeWrite: (connection: Connection, callback: (error: AttErrors) => void) => void

	/**
	 * This optional method will be called when a write needs to be done. If this method is not present, the `value` property of the characteristic object is instead updated.
	 *
	 * In case for Prepared Writes, consecutive writes with offsets directly following the previous write to the same value are internally concatenated to the full value at the time the writes are committed. At that time this method will be called only once with the full value.
	 *
	 * The callback must be called when `needsResponse` is true. (Otherwise calling the callback is a NO-OP.)
	 *
	 * Allowed error codes:
	 * * `AttErrors.SUCCESS`
	 * * `AttErrors.INVALID_OFFSET`
	 * * `AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH`
	 * * `AttErrors.UNLIKELY_ERROR`
	 * * `AttErrors.INSUFFICIENT_RESOURCES`
	 * * `AttErrors.PROCEDURE_ALREADY_IN_PROGRESS`
	 * * `AttErrors.OUT_OF_RANGE`
	 * * `AttErrors.WRITE_REQUEST_REJECTED`
	 * * Application errors (0x80 - 0x9f)
	 *
	 * @param connection The BLE connection that requests the write
	 * @param needsResponse Whether a response must be sent
	 * @param value The value to write
	 * @callback callback Callback that should be called with the response, if needed
	 * @param error An AttErrors result code
	 */
	onWrite: (connection: Connection, needsResponse: boolean, value: Buffer, callback: (error: AttErrors) => void) => void

	/**
	 * This optional method always overrides `onWrite`. Same as `onWrite` but can be used to handle the cases where Partial Writes are used where the starting offset in the initial write is not 0. If this happens and only `onWrite` would be present, an `AttErrors.INVALID_OFFSET` error is sent in response by the stack without calling the `onWrite` method.
	 *
	 * @param connection The BLE connection that requests the write
	 * @param needsResponse Whether a response must be sent
	 * @param offset Offset between 0 and 512 where to start the write
	 * @param value The value to write
	 * @callback callback Callback that should be called with the response, if needed
	 * @param error An AttErrors result code
	 */
	onPartialWrite: (connection: Connection, needsResponse: boolean, offset: number, value: Buffer, callback: (error: AttErrors) => void) => void


	// TODO: not described in readme
	// TODO: define unknown
	userObj: {
		onRead: unknown | null
		value: number
	},
	handle: number | null
}

interface GattServerAttribute {
	groupEndHandle?: number | null
	uuid16: number | null
	uuid: number | string
	value: Buffer
	maxLength: number
	readPerm: GattCharacteristicPermission
	writePerm: GattCharacteristicPermission
	read: (connection: unknown, opcode: unknown, offset: unknown, callback: (unknown) => void) => void
	write:  (connection: unknown, opcode: unknown, offset: unknown, callback: (unknown) => void) => void //writeFn
	authorizeWrite: (connection: unknown, opcode: unknown, offset: unknown, callback: (unknown) => void) => void //authorizeWriteFn
}


[
	{
		isSecondaryService: false,
		uuid: 0x1801,
		includedServices: [],
		characteristics: [svccCharacteristic = {
			uuid: 0x2a05,
			maxLength: 4,
			properties: ['indicate'],
			readPerm: 'not-permitted',
			writePerm: 'not-permitted',
			onSubscriptionChange: function(connection, notification, indication, isWrite) {

			},
			descriptors: []
		}]
	},
	{
		isSecondaryService: false,
		uuid: 0x1800,
		includedServices: [],
		characteristics: [
			{
				uuid: 0x2a00,
				properties: ['read'],
				readPerm: 'open',
				writePerm: 'not-permitted',
				onRead: function(connection, callback) {
					callback(0, deviceName)
				},
				maxLength: 248,
				descriptors: []
			},
			{
				uuid: 0x2a01,
				properties: ['read'],
				readPerm: 'open',
				writePerm: 'not-permitted',
				onRead: function(connection, callback) {
					callback(0, appearanceValue)
				},
				maxLength: 2,
				descriptors: []
			}
		]
	}
]

/**
 * This class is used to control the GATT DB.
 *
 * Each HCI Manager has an own instance of this class, which can be retrieved through its `gattDb` property.
 */
class GattServerDb extends EventEmitter {
	// TODO: is gattServerDb used?
	gattServerDb: GattServerDb
	allServices: GattServerService[]
	attDb: GattServerAttribute[]

	svccCharacteristic: GattServerCharacteristics[] |null
	deviceName: string
	appearanceValue: Buffer

	// TODO: define unknown
	constructor(registerOnConnected1Fn: (connection: unknown) => void, registerOnConnected2Fn: (connection: unknown) => void, registerOnDisconnectedFn: (connection: unknown) => void, registerOnBondedFn: (connection: unknown) => void, registerAttDbFn: (attDb: GattServerAttribute[]) => void) {
		super()

		this.gattServerDb = this
		this.allServices = []
		this.attDb = []

		this.svccCharacteristic = null
		this.deviceName = 'node-ble'
		this.appearanceValue = Buffer.from([0, 0])

		// TODO: Define connection
		registerOnConnected1Fn(connection => {
			if (!connection.smp.isBonded) return

			this.allServices.forEach(s => {
				s.characteristics.forEach(c => {
					c.descriptors.forEach(d => {
						if (d.uuid === fixUuid(0x2902)) {
							const cccdValue = storage.getCccd(
								storage.constructAddress(connection.ownAddressType, connection.ownAddress),
								storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
								d.handle
							)
							c.cccds[connection.id] = {connection: connection, value: cccdValue}
						}
					})
				})
			})
		})

		// TODO: Define connection
		registerOnConnected2Fn(connection => {
			if (!connection.smp.isBonded) return

			this.allServices.forEach(s => {
				s.characteristics.forEach(c => {
					c.descriptors.forEach(d => {
						if (d.uuid === fixUuid(0x2902)) {
							const cccd = c.cccds[connection.id]
							if (cccd && cccd.value) {
								const fn = c.userObj.onSubscriptionChange
								if (typeof fn === 'function') {
									const notification = !!(cccd.value & 1)
									const indication = !!(cccd.value & 2)
									fn.call(c.userObj, connection, notification, indication, false)
								}
							}
						}
					})
				})
			})
		})

		// TODO: Define connection
		registerOnDisconnectedFn(connection => {
			this.allServices.forEach(s => {
				s.characteristics.forEach(c => {
					c.descriptors.forEach(d => {
						if (d.uuid === fixUuid(0x2902)) {
							const cccd = c.cccds[connection.id]
							delete c.cccds[connection.id]
							if (cccd && cccd.value) {
								const fn = c.userObj.onSubscriptionChange
								if (typeof fn === 'function') {
									fn.call(c.userObj, connection, false, false, false)
								}
							}
						}
					})
				})
			})
		})

		// TODO: Define connection
		registerOnBondedFn(connection => {
			this.allServices.forEach(s => {
				s.characteristics.forEach(c => {
					c.descriptors.forEach(d => {
						if (d.uuid === fixUuid(0x2902)) {
							const cccdValue = c.cccds[connection.id] ? c.cccds[connection.id].value : 0
							storage.storeCccd(
								storage.constructAddress(connection.ownAddressType, connection.ownAddress),
								storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
								d.handle,
								cccdValue
							)
						}
					})
				})
			})
		})

		registerAttDbFn(this.attDb)
	}

	/**
	 * Adds one or more services to the GATT DB.
	 *
	 * @param services Array of services
	 */
	addServices(services: GattServerService[]): unknown | never {
		validate(Array.isArray(services), 'services must be an array')

		const servicesToAdd: GattServerService[] = []
		for (let si = 0; si < services.length; si++) {
			servicesToAdd.push({
				userObj: services[si],
				startHandle: null,
				endHandle: null,
				isSecondaryService: false,
				uuid: null,
				includedServices: [],
				characteristics: [],
				numberOfHandles: 1
			})
		}
		for (let si = 0; si < services.length; si++) {
			const service: GattServerService = services[si]
			const s: GattServerService = servicesToAdd[si]
			validate(typeof service === 'object' && service !== null, 'service must be an object')

			s.startHandle = service.startHandle
			validate((!s.startHandle && s.startHandle !== 0) || (Number.isInteger(s.startHandle) && s.startHandle >= 0x0001 && s.startHandle <= 0xffff), 'Invalid startHandle')

			s.isSecondaryService = !!service.isSecondaryService
			s.uuid = fixUuid(service.uuid)
			const includedServices = service.includedServices
			validate(!includedServices || Array.isArray(includedServices), 'includedServices must be an Array if present')

			if (includedServices) {
				for (let i = 0; i < includedServices.length; i++) {
					let ok = false
					for (let j = 0; j < this.allServices.length; j++) {
						if (this.allServices[j].userObj === includedServices[i]) {
							s.includedServices.push({
								startHandle: this.allServices[j].startHandle,
								endHandle: this.allServices[j].endHandle,
								uuid: this.allServices[j].uuid
							})
							ok = true
							break
						}
					}
					if (!ok) {
						for (let j = 0; j < servicesToAdd.length; j++) {
							if (servicesToAdd[j].userObj === includedServices[i]) {
								s.includedServices.push(j)
								ok = true
								break
							}
						}
					}
					validate(ok, 'All objects in the includedServices array must refer to a service already added or one that is being added')
					++s.numberOfHandles
				}
			}

			const characteristics = service.characteristics
			validate(!characteristics || Array.isArray(characteristics), 'characteristics must be an Array if present')

			if (characteristics) {
				for (let i = 0; i < characteristics.length; i++) {
					const characteristic = characteristics[i]
					validate(typeof characteristic === 'object' && characteristic !== null, 'characteristic must be an object')
					const c: GattServerCharacteristics = {
						userObj: characteristic,
						startHandle: null,
						endHandle: null,
						uuid: fixUuid(characteristic.uuid),
						descriptors: [],
						properties: 0,
						maxLength: 512,
						readPerm: GattCharacteristicPermission.OPEN,
						writePerm: GattCharacteristicPermission.OPEN,
					}
					s.characteristics.push(c)
					s.numberOfHandles += 2

					const properties = characteristic.properties
					validate(!properties || Array.isArray(properties), 'properties must be an Array if present')

					if (properties) {
						for (let j = 0; j < properties.length; j++) {
							// TODO: Replace by ENUM!
							const index = ['broadcast', 'read', 'write-without-response', 'write', 'notify', 'indicate', 'authenticated-signed-writes', 'reliable-write', 'writable-auxiliaries'].indexOf(properties[j])
							validate(index >= 0 && index !== 6, 'A characteristic property is not valid')
							c.properties |= (1 << index)
						}
					}

					const maxLength = characteristic.maxLength
					validate(typeof maxLength === 'undefined' || (Number.isInteger(maxLength) && maxLength >= 0 && maxLength <= 512), 'Invalid maxLength')
					if (!(typeof maxLength === 'undefined')) {
						c.maxLength = maxLength
					}

					// TODO: Replace by ENUM!
					const permTypes = ['not-permitted', 'open', 'encrypted', 'encrypted-mitm', 'encrypted-mitm-sc', 'custom']
					const readPerm = characteristic.readPerm
					if (readPerm) {
						validate(permTypes.some(t => t === readPerm), 'Invalid readPerm')
						validate((readPerm !== GattCharacteristicPermission.NOT_PERMITTED) === !!(c.properties & 0x02), 'Invalid characteristic permission configuration for the read property.')
						c.readPerm = readPerm
					} else {
						if (!(c.properties & 0x02)) {
							c.readPerm = GattCharacteristicPermission.NOT_PERMITTED
						}
					}
					const writePerm = characteristic.writePerm
					if (writePerm) {
						validate(permTypes.some(t => t === writePerm), 'Invalid writePerm')
						validate((writePerm !== GattCharacteristicPermission.NOT_PERMITTED) === !!(c.properties & 0x8c), 'Invalid characteristic permission configuration for the write/write-without-response/reliable-write property.')
						c.writePerm = writePerm
					} else {
						if (!(c.properties & 0x8c)) {
							c.writePerm = GattCharacteristicPermission.NOT_PERMITTED
						}
					}

					var descriptors = characteristic.descriptors
					validate(!descriptors || Array.isArray(descriptors), 'descriptors must be an Array if present')
					if (descriptors) {
						for (var j = 0; j < descriptors.length; j++) {
							var descriptor = descriptors[j]
							var d = {
								userObj: descriptor,
								handle: null,
								uuid: fixUuid(descriptor.uuid),
								maxLength: 512,
								readPerm: 'open',
								writePerm: 'open'
							}
							c.descriptors.push(d)

							maxLength = descriptor.maxLength
							validate(typeof maxLength === 'undefined' || (Number.isInteger(maxLength) && maxLength >= 0 && maxLength <= 512), 'Invalid maxLength')
							if (!(typeof maxLength === 'undefined')) {
								d.maxLength = maxLength
							}

							readPerm = descriptor.readPerm
							if (readPerm) {
								validate(permTypes.some(t => t === readPerm), 'Invalid readPerm')
								d.readPerm = readPerm
							}
							writePerm = descriptor.writePerm
							if (writePerm) {
								validate(permTypes.some(t => t === writePerm), 'Invalid writePerm')
								d.writePerm = writePerm
							}
							++s.numberOfHandles
						}
					}

					// Add ccc descriptor and extended properties descriptor, if needed
					if (c.properties & (3 << 4)) {
						if (!c.descriptors.some(d => d.uuid === fixUuid(0x2902))) {
							c.descriptors.push({
								userObj: Object.create(null),
								handle: null,
								uuid: fixUuid(0x2902),
								maxLength: 2,
								readPerm: 'open',
								writePerm: 'open'
							})
							++s.numberOfHandles
						}
					}
					validate(!c.descriptors.some(d => d.uuid === fixUuid(0x2900)), 'The Characteristic Extended Properties descriptor is created automatically if needed and cannot be created manually')
					if (c.properties >> 7) {
						c.descriptors.push({
							userObj: {
								onRead: null,
								value: c.properties >> 7
							},
							handle: null,
							uuid: fixUuid(0x2900),
							maxLength: 2,
							readPerm: 'open',
							writePerm: 'not-permitted'
						})
						++s.numberOfHandles
					}

					var cccdFound = false
					for (var j = 0; j < c.descriptors.length; j++) {
						var d = c.descriptors[j]
						if (d.uuid === fixUuid(0x2902)) {
							validate(!cccdFound, 'Can only have one Client Characteristic Configuration descriptor per characteristic')
							cccdFound = true
							c.cccds = Object.create(null)
						}
					}
				}
			}
		}
		var insertPositions = []
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]
			var chosenStartHandle = 0x0000
			var chosenPosition
			var lastHandle = 0x0000

			allServices.push({startHandle: 0xffff})
			for (var i = 0; i < allServices.length; i++) {
				if (allServices[i].startHandle - lastHandle - 1 >= s.numberOfHandles) {
					if (chosenStartHandle === 0x0000) {
						chosenStartHandle = lastHandle + 1
						chosenPosition = i
					}
					if (s.startHandle && lastHandle + 1 <= s.startHandle && s.startHandle + s.numberOfHandles <= allServices[i].startHandle) {
						chosenStartHandle = s.startHandle
						chosenPosition = i
						break
					}
				}
				lastHandle = allServices[i].endHandle
			}
			allServices.pop()
			if (chosenStartHandle) {
				s.startHandle = chosenStartHandle
				s.endHandle = chosenStartHandle + s.numberOfHandles - 1
				allServices.splice(chosenPosition, 0, s)
				insertPositions.push(chosenPosition)
			} else {
				while (insertPositions.length !== 0) {
					allServices.splice(insertPositions.pop(), 1)
				}
				throw new Error('No space for these services in the db')
			}
		}
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]

			var handle = s.startHandle

			// Service Declaration
			addAttribute(handle++, s.endHandle, !s.isSecondaryService ? 0x2800 : 0x2801, serializeUuid(s.uuid), 512, 'open', 'not-permitted')

			for (var i = 0; i < s.includedServices.length; i++) {
				if (Number.isInteger(s.includedServices[i])) {
					var s2 = servicesToAdd[s.includedServices[i]]
					s.includedServices[i] = {startHandle: s2.startHandle, endHandle: s2.endHandle, uuid: s2.uuid}
				}

				// Include Declaration
				var uuid = serializeUuid(s.includedServices[i])
				var val = Buffer.alloc(4 + (uuid.length === 2 ? 2 : 0))
				val.writeUInt16LE(s.includedServices[i].startHandle, 0)
				val.writeUInt16LE(s.includedServices[i].endHandle, 2)
				if (uuid.length === 2) {
					uuid.copy(val, 4)
				}
				addAttribute(handle++, undefined, 0x2802, val, 512, 'open', 'not-permitted')
			}

			s.characteristics.forEach(c => {
				c.startHandle = handle++

				// Characteristic Declaration
				var uuid = serializeUuid(c.uuid)
				var val = Buffer.alloc(3 + uuid.length)
				val[0] = (c.properties & 0xff) | ((c.properties >> 1) & 0x80); // If any extended property, set the extended properties flag
				val.writeUInt16LE(handle, 1)
				uuid.copy(val, 3)
				addAttribute(c.startHandle, c.startHandle + 1 + c.descriptors.length, 0x2803, val, 512, 'open', 'not-permitted')

				function createReadFn(obj, isCccd) {
					return function(connection, opcode, offset, callback) {
						if (isCccd) {
							var value = Buffer.from([c.cccds[connection.id] ? c.cccds[connection.id].value : 0, 0])
							callback(0, value.slice(offset))
							return
						}


						if (obj.readPerm === 'custom') {
							var authorizeFn = obj.userObj.onAuthorizeRead
							validate(typeof authorizeFn === 'function', 'The readPerm is custom, but no onAuthorizeRead function exists')
							var usedAuthorizeCallback = false
							authorizeFn.call(obj.userObj, connection, function(err) {
								if (usedAuthorizeCallback) {
									return
								}
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								usedAuthorizeCallback = true
								if (!connection.disconnected) {
									if (err) {
										callback(err)
									} else {
										cont()
									}
								}
							})
							return
						}

						cont()
						function cont() {
							var fn = obj.userObj.onPartialRead
							if (typeof fn === 'function') {
								var usedCallback = false
								fn.call(obj.userObj, connection, offset, function(err, value) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									if (!err) {
										if (typeof value === 'string') {
											value = Buffer.from(value)
										}
										validate(value instanceof Buffer, 'Invalid attribute value')
										validate(offset + value.length <= obj.maxLength, 'The supplied value exceeds the maximum length for this value')
									}
									usedCallback = true
									callback(err, err ? null : value)
								})
								return
							}

							fn = obj.userObj.onRead
							if (typeof fn === 'function') {
								var usedCallback = false
								fn.call(obj.userObj, connection, function(err, value) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									if (!err) {
										if (typeof value === 'string') {
											value = Buffer.from(value)
										}
										validate(value instanceof Buffer, 'Invalid attribute value')
										validate(value.length <= obj.maxLength, 'The supplied value exceeds the maximum length for this value')
										if (offset > value.length) {
											err = AttErrors.INVALID_OFFSET
										}
										value = value.slice(offset)
									}
									usedCallback = true
									callback(err, err ? null : value)
								})
								return
							}

							var value = obj.userObj.value
							if (typeof value === 'string') {
								value = Buffer.from(value)
							}
							if (!(value instanceof Buffer)) {
								// Can't throw here, so just set it to empty buffer
								value = Buffer.alloc(0)
							}
							value = value.slice(0, obj.maxLength)
							offset > value.length ? callback(AttErrors.INVALID_OFFSET) : callback(0, value.slice(offset))
						}
					}
				}

				function createWriteFn(obj, isCccd) {
					return function(connection, opcode, offset, value, callback) {
						if (isCccd) {
							if (offset > 2) {
								callback(AttErrors.INVALID_OFFSET)
								return
							}
							if (offset + value.length !== 2) {
								callback(AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
								return
							}
							var prev = Buffer.from([c.cccds[connection.id] ? c.cccds[connection.id].value : 0, 0])
							var v = Buffer.concat([prev.slice(0, offset), value])

							var notification = !!(v[0] & 1)
							var indication = !!(v[0] & 2)

							if ((notification && !(c.properties & 0x10)) || (indication && !(c.properties & 0x20)) || v[1] !== 0 || v[0] > 3) {
								callback(AttErrors.CLIENT_CHARACTERISTIC_CONFIGURATION_DESCRIPTOR_IMPROPERLY_CONFIGURED)
								return
							}

							if (!c.cccds[connection.id]) {
								c.cccds[connection.id] = {connection: connection, value: v[0]}
							} else {
								c.cccds[connection.id].value = v[0]
							}

							if (connection.smp.isBonded && !prev.equals(v)) {
								storage.storeCccd(
									storage.constructAddress(connection.ownAddressType, connection.ownAddress),
									storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
									obj.handle,
									v[0]
								)
							}

							callback(0)

							var fn = c.userObj.onSubscriptionChange
							if (typeof fn === 'function') {
								fn.call(c.userObj, connection, notification, indication, true)
							}
							return
						}
						if (offset > obj.maxLength) {
							callback(AttErrors.INVALID_OFFSET)
							return
						}
						if (offset + value.length > obj.maxLength) {
							callback(AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
							return
						}

						var fn = obj.userObj.onPartialWrite
						if (typeof fn === 'function') {
							var usedCallback = false
							fn.call(obj.userObj, connection, opcode !== BleGattAttribute.WRITE_COMMAND, offset, value, function(err) {
								if (usedCallback) {
									return
								}
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								usedCallback = true
								callback(err)
							})
							return
						}
						fn = obj.userObj.onWrite
						if (typeof fn === 'function') {
							if (offset === 0) {
								var usedCallback = false
								fn.call(obj.userObj, connection, opcode !== BleGattAttribute.WRITE_COMMAND, value, function(err) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									usedCallback = true
									callback(err)
								})
							} else {
								callback(AttErrors.INVALID_OFFSET)
							}
							return
						}
						var v = obj.userObj.value
						var isString = typeof v === 'string'
						if (offset !== 0) {
							if (isString) {
								v = Buffer.from(v)
							}
							if (offset > v.length) {
								callback(AttErrors.INVALID_OFFSET)
								return
							}
							value = Buffer.concat([v.slice(0, offset), value])
						}
						obj.userObj.value = isString ? value.toString() : value
						callback(0)
					}
				}

				function createAuthorizeWriteFn(obj) {
					return function(connection, opcode, offset, value, callback) {
						if (obj.writePerm !== 'custom') {
							callback(0)
						} else {
							var fn = obj.userObj.onAuthorizeWrite
							validate(typeof fn === 'function', 'The writePerm is custom, but no onAuthorizeWrite function exists')
							fn.call(obj.userObj, connection, function(err) {
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								callback(err)
							})
						}
					}
				}

				// Characteristic Value declaration
				addAttribute(handle++, undefined, c.uuid, undefined, c.maxLength, c.readPerm, c.writePerm, createReadFn(c), createWriteFn(c), createAuthorizeWriteFn(c))

				c.descriptors.forEach(d => {
					d.handle = handle

					var isCccd = d.uuid === fixUuid(0x2902)

					// Characteristic descriptor declaration
					addAttribute(handle++, undefined, d.uuid, undefined, d.maxLength, d.readPerm, d.writePerm, createReadFn(d, isCccd), createWriteFn(d, isCccd), createAuthorizeWriteFn(d))

					if (isCccd) {
						var getActiveSubscribers = function() {
							var res = []
							for (var id in c.cccds) {
								var subscriber = c.cccds[id]
								if (subscriber.value) {
									res.push({connection: subscriber.connection, value: subscriber.value})
								}
							}
							return res
						}

						function validateBuffer(value) {
							if (typeof value === 'string') {
								value = Buffer.from(value)
							}
							validate(value instanceof Buffer, 'Invalid value')
							return value
						}

						c.userObj.notifyAll = function(value) {
							value = validateBuffer(value)
							getActiveSubscribers().forEach(s => {
								if (s.value & 1) {
									s.connection.gatt._notify(c.startHandle + 1, value, function() {}, function() {})
								}
							})
						}

						c.userObj.indicateAll = function(value) {
							value = validateBuffer(value)
							getActiveSubscribers().forEach(s => {
								if (s.value & 2) {
									s.connection.gatt._indicate(c.startHandle + 1, value, function() {})
								}
							})
						}

						c.userObj.notify = function(connection, value, sentCallback, completeCallback) {
							value = validateBuffer(value)
							validate(!sentCallback || typeof sentCallback === 'function', 'Invalid sentCallback')
							validate(!completeCallback || typeof completeCallback === 'function', 'Invalid completeCallback')
							if (sentCallback) {
								sentCallback = sentCallback.bind(c.userObj)
							}
							if (completeCallback) {
								completeCallback = completeCallback.bind(c.userObj)
							}

							var subscriber = c.cccds[connection.id]
							if (!subscriber || !(subscriber.value & 1)) {
								return false
							}
							subscriber.connection.gatt._notify(c.startHandle + 1, value, sentCallback || function() {}, completeCallback || function() {})
							return true
						}

						c.userObj.indicate = function(connection, value, callback) {
							value = validateBuffer(value)
							validate(!callback || typeof callback === 'function', 'Invalid callback')
							if (callback) {
								callback = callback.bind(c.userObj)
							}

							var subscriber = c.cccds[connection.id]
							if (!subscriber || !(subscriber.value & 2)) {
								return false
							}
							subscriber.connection.gatt._indicate(c.startHandle + 1, value, callback || function() {})
							return true
						}
					}
				})

				c.endHandle = handle - 1
			})
		}
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]
			s.userObj.startHandle = s.startHandle
			s.userObj.endHandle = s.endHandle
		}
	}

	/**
	 * Sets the Device Name characteristic.
	 *
	 * @param name The new device name to store in the Device Name characteristic (max 248 bytes)
	 */
	setDeviceName(name: Buffer | string): unknown {

	}

	/**
	 * Sets the Appearance characteristic.
	 *
	 * @param appearance 16-bit unsigned integer
	 */

	setAppearance(appearance: number): unknown {

	}

	/**
	 * Returns the Service Changed Characteristic in the GATT service which is automatically created. Use this to send indications if the GATT DB is changed. The stack never sends indications on its own if the GATT DB is changed, so this must be done manually by the user.
	 *
	 * @return The Service Changed Characteristic
	 */

	getSvccCharacteristic(): GattServerCharacteristics {

	}

	/**
	 * Removes a service previously added.
	 * If services are removed, you should indicate to all current connections and all bonded devices that the services in the modified range have been changed.
	 *
	 * Note that if a service used as an included service is removed, the included service definition is not removed and will therefore be dangling.
	 * Therefore that "parent" service should also be removed, or a new service with the same UUID and size should be added back to the same position as the one being removed.
	 *
	 * @param service A service to remove
	 *
	 * @return Whether the specified service was found and therefore could be removed
	 */
	removeService(service: GattServerService): boolean {

	}
}



function GattServerDb_legacy(registerOnConnected1Fn, registerOnConnected2Fn, registerOnDisconnectedFn, registerOnBondedFn, registerAttDbFn) {
	EventEmitter.call(this)
	var gattServerDb = this
	var allServices = []
	var attDb = []

	var svccCharacteristic = null
	var deviceName = 'node-ble'
	var appearanceValue = Buffer.from([0, 0])

	registerOnConnected1Fn(connection => {
		if (!connection.smp.isBonded) {
			return
		}
		allServices.forEach(s => {
			s.characteristics.forEach(c => {
				c.descriptors.forEach(d => {
					if (d.uuid === fixUuid(0x2902)) {
						var cccdValue = storage.getCccd(
							storage.constructAddress(connection.ownAddressType, connection.ownAddress),
							storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
							d.handle
						)
						c.cccds[connection.id] = {connection: connection, value: cccdValue}
					}
				})
			})
		})
	})

	registerOnConnected2Fn(connection => {
		if (!connection.smp.isBonded) {
			return
		}
		allServices.forEach(s => {
			s.characteristics.forEach(c => {
				c.descriptors.forEach(d => {
					if (d.uuid === fixUuid(0x2902)) {
						var cccd = c.cccds[connection.id]
						if (cccd && cccd.value) {
							var fn = c.userObj.onSubscriptionChange
							if (typeof fn === 'function') {
								var notification = !!(cccd.value & 1)
								var indication = !!(cccd.value & 2)
								fn.call(c.userObj, connection, notification, indication, false)
							}
						}
					}
				})
			})
		})
	})

	registerOnDisconnectedFn(connection => {
		allServices.forEach(s => {
			s.characteristics.forEach(c => {
				c.descriptors.forEach(d => {
					if (d.uuid === fixUuid(0x2902)) {
						var cccd = c.cccds[connection.id]
						delete c.cccds[connection.id]
						if (cccd && cccd.value) {
							var fn = c.userObj.onSubscriptionChange
							if (typeof fn === 'function') {
								fn.call(c.userObj, connection, false, false, false)
							}
						}
					}
				})
			})
		})
	})

	registerOnBondedFn(connection => {
		allServices.forEach(s => {
			s.characteristics.forEach(c => {
				c.descriptors.forEach(d => {
					if (d.uuid === fixUuid(0x2902)) {
						var cccdValue = c.cccds[connection.id] ? c.cccds[connection.id].value : 0
						storage.storeCccd(
							storage.constructAddress(connection.ownAddressType, connection.ownAddress),
							storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
							d.handle,
							cccdValue
						)
					}
				})
			})
		})
	})

	registerAttDbFn(attDb)

	function addServices(services) {
		validate(Array.isArray(services), 'services must be an array')

		var servicesToAdd = []
		for (var si = 0; si < services.length; si++) {
			servicesToAdd.push({
				userObj: services[si],
				startHandle: null,
				endHandle: null,
				isSecondaryService: false,
				uuid: null,
				includedServices: [],
				characteristics: [],
				numberOfHandles: 1
			})
		}
		for (var si = 0; si < services.length; si++) {
			var service = services[si]
			var s = servicesToAdd[si]
			validate(typeof service === 'object' && service !== null, 'service must be an object')
			s.startHandle = service.startHandle
			validate((!s.startHandle && s.startHandle !== 0) || (Number.isInteger(s.startHandle) && s.startHandle >= 0x0001 && s.startHandle <= 0xffff), 'Invalid startHandle')
			s.isSecondaryService = !!service.isSecondaryService
			s.uuid = fixUuid(service.uuid)
			var includedServices = service.includedServices
			validate(!includedServices || Array.isArray(includedServices), 'includedServices must be an Array if present')
			if (includedServices) {
				for (var i = 0; i < includedServices.length; i++) {
					var ok = false
					for (var j = 0; j < allServices.length; j++) {
						if (allServices[j].userObj === includedServices[i]) {
							s.includedServices.push({startHandle: allServices[j].startHandle, endHandle: allServices[j].endHandle, uuid: allServices[j].uuid})
							ok = true
							break
						}
					}
					if (!ok) {
						for (var j = 0; j < servicesToAdd.length; j++) {
							if (servicesToAdd[j].userObj === includedServices[i]) {
								s.includedServices.push(j)
								ok = true
								break
							}
						}
					}
					validate(ok, 'All objects in the includedServices array must refer to a service already added or one that is being added')
					++s.numberOfHandles
				}
			}
			var characteristics = service.characteristics
			validate(!characteristics || Array.isArray(characteristics), 'characteristics must be an Array if present')
			if (characteristics) {
				for (var i = 0; i < characteristics.length; i++) {
					var characteristic = characteristics[i]
					validate(typeof characteristic === 'object' && characteristic !== null, 'characteristic must be an object')
					var c = {
						userObj: characteristic,
						startHandle: null,
						endHandle: null,
						uuid: fixUuid(characteristic.uuid),
						descriptors: [],
						properties: 0,
						maxLength: 512,
						readPerm: 'open',
						writePerm: 'open'
					}
					s.characteristics.push(c)
					s.numberOfHandles += 2

					var properties = characteristic.properties
					validate(!properties || Array.isArray(properties), 'properties must be an Array if present')
					if (properties) {
						for (var j = 0; j < properties.length; j++) {
							var index = ['broadcast', 'read', 'write-without-response', 'write', 'notify', 'indicate', 'authenticated-signed-writes', 'reliable-write', 'writable-auxiliaries'].indexOf(properties[j])
							validate(index >= 0 && index !== 6, 'A characteristic property is not valid')
							c.properties |= (1 << index)
						}
					}

					var maxLength = characteristic.maxLength
					validate(typeof maxLength === 'undefined' || (Number.isInteger(maxLength) && maxLength >= 0 && maxLength <= 512), 'Invalid maxLength')
					if (!(typeof maxLength === 'undefined')) {
						c.maxLength = maxLength
					}

					var permTypes = ['not-permitted', 'open', 'encrypted', 'encrypted-mitm', 'encrypted-mitm-sc', 'custom']
					var readPerm = characteristic.readPerm
					if (readPerm) {
						validate(permTypes.some(t => t === readPerm), 'Invalid readPerm')
						validate((readPerm !== 'not-permitted') === !!(c.properties & 0x02), 'Invalid characteristic permission configuration for the read property.')
						c.readPerm = readPerm
					} else {
						if (!(c.properties & 0x02)) {
							c.readPerm = 'not-permitted'
						}
					}
					var writePerm = characteristic.writePerm
					if (writePerm) {
						validate(permTypes.some(t => t === writePerm), 'Invalid writePerm')
						validate((writePerm !== 'not-permitted') === !!(c.properties & 0x8c), 'Invalid characteristic permission configuration for the write/write-without-response/reliable-write property.')
						c.writePerm = writePerm
					} else {
						if (!(c.properties & 0x8c)) {
							c.writePerm = 'not-permitted'
						}
					}

					var descriptors = characteristic.descriptors
					validate(!descriptors || Array.isArray(descriptors), 'descriptors must be an Array if present')
					if (descriptors) {
						for (var j = 0; j < descriptors.length; j++) {
							var descriptor = descriptors[j]
							var d = {
								userObj: descriptor,
								handle: null,
								uuid: fixUuid(descriptor.uuid),
								maxLength: 512,
								readPerm: 'open',
								writePerm: 'open'
							}
							c.descriptors.push(d)

							maxLength = descriptor.maxLength
							validate(typeof maxLength === 'undefined' || (Number.isInteger(maxLength) && maxLength >= 0 && maxLength <= 512), 'Invalid maxLength')
							if (!(typeof maxLength === 'undefined')) {
								d.maxLength = maxLength
							}

							readPerm = descriptor.readPerm
							if (readPerm) {
								validate(permTypes.some(t => t === readPerm), 'Invalid readPerm')
								d.readPerm = readPerm
							}
							writePerm = descriptor.writePerm
							if (writePerm) {
								validate(permTypes.some(t => t === writePerm), 'Invalid writePerm')
								d.writePerm = writePerm
							}
							++s.numberOfHandles
						}
					}

					// Add ccc descriptor and extended properties descriptor, if needed
					if (c.properties & (3 << 4)) {
						if (!c.descriptors.some(d => d.uuid === fixUuid(0x2902))) {
							c.descriptors.push({
								userObj: Object.create(null),
								handle: null,
								uuid: fixUuid(0x2902),
								maxLength: 2,
								readPerm: 'open',
								writePerm: 'open'
							})
							++s.numberOfHandles
						}
					}
					validate(!c.descriptors.some(d => d.uuid === fixUuid(0x2900)), 'The Characteristic Extended Properties descriptor is created automatically if needed and cannot be created manually')
					if (c.properties >> 7) {
						c.descriptors.push({
							userObj: {
								onRead: null,
								value: c.properties >> 7
							},
							handle: null,
							uuid: fixUuid(0x2900),
							maxLength: 2,
							readPerm: 'open',
							writePerm: 'not-permitted'
						})
						++s.numberOfHandles
					}

					var cccdFound = false
					for (var j = 0; j < c.descriptors.length; j++) {
						var d = c.descriptors[j]
						if (d.uuid === fixUuid(0x2902)) {
							validate(!cccdFound, 'Can only have one Client Characteristic Configuration descriptor per characteristic')
							cccdFound = true
							c.cccds = Object.create(null)
						}
					}
				}
			}
		}
		var insertPositions = []
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]
			var chosenStartHandle = 0x0000
			var chosenPosition
			var lastHandle = 0x0000

			allServices.push({startHandle: 0xffff})
			for (var i = 0; i < allServices.length; i++) {
				if (allServices[i].startHandle - lastHandle - 1 >= s.numberOfHandles) {
					if (chosenStartHandle === 0x0000) {
						chosenStartHandle = lastHandle + 1
						chosenPosition = i
					}
					if (s.startHandle && lastHandle + 1 <= s.startHandle && s.startHandle + s.numberOfHandles <= allServices[i].startHandle) {
						chosenStartHandle = s.startHandle
						chosenPosition = i
						break
					}
				}
				lastHandle = allServices[i].endHandle
			}
			allServices.pop()
			if (chosenStartHandle) {
				s.startHandle = chosenStartHandle
				s.endHandle = chosenStartHandle + s.numberOfHandles - 1
				allServices.splice(chosenPosition, 0, s)
				insertPositions.push(chosenPosition)
			} else {
				while (insertPositions.length !== 0) {
					allServices.splice(insertPositions.pop(), 1)
				}
				throw new Error('No space for these services in the db')
			}
		}
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]

			var handle = s.startHandle

			// Service Declaration
			addAttribute(handle++, s.endHandle, !s.isSecondaryService ? 0x2800 : 0x2801, serializeUuid(s.uuid), 512, 'open', 'not-permitted')

			for (var i = 0; i < s.includedServices.length; i++) {
				if (Number.isInteger(s.includedServices[i])) {
					var s2 = servicesToAdd[s.includedServices[i]]
					s.includedServices[i] = {startHandle: s2.startHandle, endHandle: s2.endHandle, uuid: s2.uuid}
				}

				// Include Declaration
				var uuid = serializeUuid(s.includedServices[i])
				var val = Buffer.alloc(4 + (uuid.length === 2 ? 2 : 0))
				val.writeUInt16LE(s.includedServices[i].startHandle, 0)
				val.writeUInt16LE(s.includedServices[i].endHandle, 2)
				if (uuid.length === 2) {
					uuid.copy(val, 4)
				}
				addAttribute(handle++, undefined, 0x2802, val, 512, 'open', 'not-permitted')
			}

			s.characteristics.forEach(c => {
				c.startHandle = handle++

				// Characteristic Declaration
				var uuid = serializeUuid(c.uuid)
				var val = Buffer.alloc(3 + uuid.length)
				val[0] = (c.properties & 0xff) | ((c.properties >> 1) & 0x80); // If any extended property, set the extended properties flag
				val.writeUInt16LE(handle, 1)
				uuid.copy(val, 3)
				addAttribute(c.startHandle, c.startHandle + 1 + c.descriptors.length, 0x2803, val, 512, 'open', 'not-permitted')

				function createReadFn(obj, isCccd) {
					return function(connection, opcode, offset, callback) {
						if (isCccd) {
							var value = Buffer.from([c.cccds[connection.id] ? c.cccds[connection.id].value : 0, 0])
							callback(0, value.slice(offset))
							return
						}


						if (obj.readPerm === 'custom') {
							var authorizeFn = obj.userObj.onAuthorizeRead
							validate(typeof authorizeFn === 'function', 'The readPerm is custom, but no onAuthorizeRead function exists')
							var usedAuthorizeCallback = false
							authorizeFn.call(obj.userObj, connection, function(err) {
								if (usedAuthorizeCallback) {
									return
								}
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								usedAuthorizeCallback = true
								if (!connection.disconnected) {
									if (err) {
										callback(err)
									} else {
										cont()
									}
								}
							})
							return
						}

						cont()
						function cont() {
							var fn = obj.userObj.onPartialRead
							if (typeof fn === 'function') {
								var usedCallback = false
								fn.call(obj.userObj, connection, offset, function(err, value) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									if (!err) {
										if (typeof value === 'string') {
											value = Buffer.from(value)
										}
										validate(value instanceof Buffer, 'Invalid attribute value')
										validate(offset + value.length <= obj.maxLength, 'The supplied value exceeds the maximum length for this value')
									}
									usedCallback = true
									callback(err, err ? null : value)
								})
								return
							}

							fn = obj.userObj.onRead
							if (typeof fn === 'function') {
								var usedCallback = false
								fn.call(obj.userObj, connection, function(err, value) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									if (!err) {
										if (typeof value === 'string') {
											value = Buffer.from(value)
										}
										validate(value instanceof Buffer, 'Invalid attribute value')
										validate(value.length <= obj.maxLength, 'The supplied value exceeds the maximum length for this value')
										if (offset > value.length) {
											err = AttErrors.INVALID_OFFSET
										}
										value = value.slice(offset)
									}
									usedCallback = true
									callback(err, err ? null : value)
								})
								return
							}

							var value = obj.userObj.value
							if (typeof value === 'string') {
								value = Buffer.from(value)
							}
							if (!(value instanceof Buffer)) {
								// Can't throw here, so just set it to empty buffer
								value = Buffer.alloc(0)
							}
							value = value.slice(0, obj.maxLength)
							offset > value.length ? callback(AttErrors.INVALID_OFFSET) : callback(0, value.slice(offset))
						}
					}
				}

				function createWriteFn(obj, isCccd) {
					return function(connection, opcode, offset, value, callback) {
						if (isCccd) {
							if (offset > 2) {
								callback(AttErrors.INVALID_OFFSET)
								return
							}
							if (offset + value.length !== 2) {
								callback(AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
								return
							}
							var prev = Buffer.from([c.cccds[connection.id] ? c.cccds[connection.id].value : 0, 0])
							var v = Buffer.concat([prev.slice(0, offset), value])

							var notification = !!(v[0] & 1)
							var indication = !!(v[0] & 2)

							if ((notification && !(c.properties & 0x10)) || (indication && !(c.properties & 0x20)) || v[1] !== 0 || v[0] > 3) {
								callback(AttErrors.CLIENT_CHARACTERISTIC_CONFIGURATION_DESCRIPTOR_IMPROPERLY_CONFIGURED)
								return
							}

							if (!c.cccds[connection.id]) {
								c.cccds[connection.id] = {connection: connection, value: v[0]}
							} else {
								c.cccds[connection.id].value = v[0]
							}

							if (connection.smp.isBonded && !prev.equals(v)) {
								storage.storeCccd(
									storage.constructAddress(connection.ownAddressType, connection.ownAddress),
									storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress),
									obj.handle,
									v[0]
								)
							}

							callback(0)

							var fn = c.userObj.onSubscriptionChange
							if (typeof fn === 'function') {
								fn.call(c.userObj, connection, notification, indication, true)
							}
							return
						}
						if (offset > obj.maxLength) {
							callback(AttErrors.INVALID_OFFSET)
							return
						}
						if (offset + value.length > obj.maxLength) {
							callback(AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
							return
						}

						var fn = obj.userObj.onPartialWrite
						if (typeof fn === 'function') {
							var usedCallback = false
							fn.call(obj.userObj, connection, opcode !== BleGattAttribute.WRITE_COMMAND, offset, value, function(err) {
								if (usedCallback) {
									return
								}
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								usedCallback = true
								callback(err)
							})
							return
						}
						fn = obj.userObj.onWrite
						if (typeof fn === 'function') {
							if (offset === 0) {
								var usedCallback = false
								fn.call(obj.userObj, connection, opcode !== BleGattAttribute.WRITE_COMMAND, value, function(err) {
									if (usedCallback) {
										return
									}
									err = err || 0
									validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
									usedCallback = true
									callback(err)
								})
							} else {
								callback(AttErrors.INVALID_OFFSET)
							}
							return
						}
						var v = obj.userObj.value
						var isString = typeof v === 'string'
						if (offset !== 0) {
							if (isString) {
								v = Buffer.from(v)
							}
							if (offset > v.length) {
								callback(AttErrors.INVALID_OFFSET)
								return
							}
							value = Buffer.concat([v.slice(0, offset), value])
						}
						obj.userObj.value = isString ? value.toString() : value
						callback(0)
					}
				}

				function createAuthorizeWriteFn(obj) {
					return function(connection, opcode, offset, value, callback) {
						if (obj.writePerm !== 'custom') {
							callback(0)
						} else {
							var fn = obj.userObj.onAuthorizeWrite
							validate(typeof fn === 'function', 'The writePerm is custom, but no onAuthorizeWrite function exists')
							fn.call(obj.userObj, connection, function(err) {
								err = err || 0
								validate(Number.isInteger(err) && err >= 0 && err <= 0xff, 'Invalid error code')
								callback(err)
							})
						}
					}
				}

				// Characteristic Value declaration
				addAttribute(handle++, undefined, c.uuid, undefined, c.maxLength, c.readPerm, c.writePerm, createReadFn(c), createWriteFn(c), createAuthorizeWriteFn(c))

				c.descriptors.forEach(d => {
					d.handle = handle

					var isCccd = d.uuid === fixUuid(0x2902)

					// Characteristic descriptor declaration
					addAttribute(handle++, undefined, d.uuid, undefined, d.maxLength, d.readPerm, d.writePerm, createReadFn(d, isCccd), createWriteFn(d, isCccd), createAuthorizeWriteFn(d))

					if (isCccd) {
						var getActiveSubscribers = function() {
							var res = []
							for (var id in c.cccds) {
								var subscriber = c.cccds[id]
								if (subscriber.value) {
									res.push({connection: subscriber.connection, value: subscriber.value})
								}
							}
							return res
						}

						function validateBuffer(value) {
							if (typeof value === 'string') {
								value = Buffer.from(value)
							}
							validate(value instanceof Buffer, 'Invalid value')
							return value
						}

						c.userObj.notifyAll = function(value) {
							value = validateBuffer(value)
							getActiveSubscribers().forEach(s => {
								if (s.value & 1) {
									s.connection.gatt._notify(c.startHandle + 1, value, function() {}, function() {})
								}
							})
						}

						c.userObj.indicateAll = function(value) {
							value = validateBuffer(value)
							getActiveSubscribers().forEach(s => {
								if (s.value & 2) {
									s.connection.gatt._indicate(c.startHandle + 1, value, function() {})
								}
							})
						}

						c.userObj.notify = function(connection, value, sentCallback, completeCallback) {
							value = validateBuffer(value)
							validate(!sentCallback || typeof sentCallback === 'function', 'Invalid sentCallback')
							validate(!completeCallback || typeof completeCallback === 'function', 'Invalid completeCallback')
							if (sentCallback) {
								sentCallback = sentCallback.bind(c.userObj)
							}
							if (completeCallback) {
								completeCallback = completeCallback.bind(c.userObj)
							}

							var subscriber = c.cccds[connection.id]
							if (!subscriber || !(subscriber.value & 1)) {
								return false
							}
							subscriber.connection.gatt._notify(c.startHandle + 1, value, sentCallback || function() {}, completeCallback || function() {})
							return true
						}

						c.userObj.indicate = function(connection, value, callback) {
							value = validateBuffer(value)
							validate(!callback || typeof callback === 'function', 'Invalid callback')
							if (callback) {
								callback = callback.bind(c.userObj)
							}

							var subscriber = c.cccds[connection.id]
							if (!subscriber || !(subscriber.value & 2)) {
								return false
							}
							subscriber.connection.gatt._indicate(c.startHandle + 1, value, callback || function() {})
							return true
						}
					}
				})

				c.endHandle = handle - 1
			})
		}
		for (var si = 0; si < services.length; si++) {
			var s = servicesToAdd[si]
			s.userObj.startHandle = s.startHandle
			s.userObj.endHandle = s.endHandle
		}
	}

	function addAttribute(handle, groupEndHandle, uuid, value, maxLength, readPerm, writePerm, readFn, writeFn, authorizeWriteFn) {
		//console.log('Inserting ', handle, groupEndHandle, uuid)
		uuid = getFullUuid(uuid)
		attDb[handle] = {
			groupEndHandle: groupEndHandle,
			uuid16: (uuid.substr(8) === BASE_UUID_SECOND_PART && uuid.substr(0, 4) === '0000') ? parseInt(uuid, 16) : null,
			uuid: uuid,
			value: value,
			maxLength: maxLength,
			readPerm: readPerm,
			writePerm: writePerm,
			read: readFn || function(connection, opcode, offset, callback) { offset > value.length ? callback(AttErrors.INVALID_OFFSET) : callback(0, value.slice(offset)); },
			write: writeFn,
			authorizeWrite: authorizeWriteFn
		}
	}

	this.setDeviceName = function(name) {
		validate(typeof name === 'string' || name instanceof Buffer, 'The name must be a string or a Buffer')
		var buf = Buffer.from(name)
		validate(buf.length <= 248, 'Name is too long. It may be up to 248 bytes.')
		deviceName = typeof name === 'string' ? name : buf
	}

	this.setAppearance = function(appearance) {
		validate(Number.isInteger(appearance) && appearance >= 0 && appearance <= 0xffff, 'Appearance must be a 16-bit integer')
		appearanceValue = Buffer.from([appearance, appearance >> 8])
	}

	this.getSvccCharacteristic = function() {
		return svccCharacteristic
	}

	this.addServices = function(services) {
		addServices(services)
		//console.log(attDb)
	}

	this.removeService = function(service) {
		for (var i = 0; i < allServices.length; i++) {
			if (allServices[i].userObj === service) {
				var s = allServices[i]
				allServices.splice(i, 1)
				for (var handle = s.startHandle; handle <= s.endHandle; handle++) {
					delete attDb[handle]
				}
				if (attDb.length === s.endHandle + 1) {
					var handle
					for (handle = s.startHandle - 1; handle >= 1; --handle) {
						if (attDb[handle]) {
							break
						}
					}
					attDb.length = handle + 1
				}
				return true
			}
		}
		return false
	}

	addServices([
		{
			isSecondaryService: false,
			uuid: 0x1801,
			includedServices: [],
			characteristics: [svccCharacteristic = {
				uuid: 0x2a05,
				maxLength: 4,
				properties: ['indicate'],
				readPerm: 'not-permitted',
				writePerm: 'not-permitted',
				onSubscriptionChange: function(connection, notification, indication, isWrite) {

				},
				descriptors: []
			}]
		},
		{
			isSecondaryService: false,
			uuid: 0x1800,
			includedServices: [],
			characteristics: [
				{
					uuid: 0x2a00,
					properties: ['read'],
					readPerm: 'open',
					writePerm: 'not-permitted',
					onRead: function(connection, callback) {
						callback(0, deviceName)
					},
					maxLength: 248,
					descriptors: []
				},
				{
					uuid: 0x2a01,
					properties: ['read'],
					readPerm: 'open',
					writePerm: 'not-permitted',
					onRead: function(connection, callback) {
						callback(0, appearanceValue)
					},
					maxLength: 2,
					descriptors: []
				}
			]
		}
	])
}
util.inherits(GattServerDb, EventEmitter)

function AttConnection(attDb, connection, registerOnDataFn, sendDataFn, notifyIndicateCallback, timeoutCallback) {
	// attDb: [{uuid16, uuid128, groupEndHandle, value, maxLength, read(connection, opcode, offset, function(err, value)),
	// write(connection, opcode, offset, value, function(err)), authorizeWrite(connection, opcode, offset, value, function(err)}]

	var currentMtu = 23
	var timedout = false

	// Client
	var requestQueue = new Queue(); // {data, callback}
	var currentOutgoingRequest = null; // {responseOpcode, callback}
	var currentOutgoingRequestIsSent
	var hasOutgoingConfirmation = false
	var requestTimeoutClearFn = function() {}

	// Server
	var isHandlingRequest = false
	var indicationQueue = new Queue(); // {data, callback}
	var currentOutgoingIndication = null; // callback
	var currentOutgoingIndicationIsSent
	var indicationTimeoutClearFn = null
	var prepareWriteQueue = []; // Array of {item, handle, offset, data}
	var prepareWriteQueueSize = 0; // Number of requests
	var notificationQueue = new Queue(); // {data, sentCallback, completeCallback}

	function attTimeout() {
		if (!timedout) {
			timedout = true
			sendDataFn = function() {}
			timeoutCallback()
		}
	}

	function sendNextRequest() {
		if (currentOutgoingRequest === null) {
			var next = requestQueue.shift()
			if (next) {
				requestTimeoutClearFn = connection.setTimeout(attTimeout, 30000)
				currentOutgoingRequest = {responseOpcode: next.data[0] + 1, callback: next.callback}
				currentOutgoingRequestIsSent = false
				sendDataFn(next.data.slice(0, currentMtu), function() {
					currentOutgoingRequestIsSent = true
				})
			}
		}
	}

	function sendResponse(buffer) {
		isHandlingRequest = true
		sendDataFn(buffer, function() {
			isHandlingRequest = false
		})
	}

	function sendErrorResponse(opcode, handle, errorCode) {
		var buffer = Buffer.alloc(5)
		buffer[0] = BleGattAttribute.ERROR_RESPONSE
		buffer[1] = opcode
		buffer.writeUInt16LE(handle, 2)
		buffer[4] = errorCode
		sendResponse(buffer)
	}

	function sendNextIndication() {
		if (currentOutgoingIndication === null && (currentOutgoingRequest === null || currentOutgoingRequest.responseOpcode !== BleGattAttribute.EXCHANGE_MTU_RESPONSE)) {
			var next = indicationQueue.shift()
			if (next) {
				indicationTimeoutClearFn = connection.setTimeout(attTimeout, 30000)
				currentOutgoingIndication = next.callback
				currentOutgoingIndicationIsSent = false
				sendDataFn(next.data.slice(0, currentMtu), function() {
					currentOutgoingIndicationIsSent = true
				})
			}
		}
	}

	function sendConfirmation() {
		hasOutgoingConfirmation = true
		sendDataFn(Buffer.from([BleGattAttribute.HANDLE_VALUE_CONFIRMATION]), function() {
			hasOutgoingConfirmation = false
		})
	}

	function checkPerm(perm, isWrite) {
		switch (perm) {
			case 'not-permitted': return isWrite ? AttErrors.WRITE_NOT_PERMITTED : AttErrors.READ_NOT_PERMITTED
			case 'open': return 0
			case 'custom': return 0
		}
		if (!connection.smp.isEncrypted) {
			return connection.smp.hasLtk ? AttErrors.INSUFFICIENT_ENCRYPTION : AttErrors.INSUFFICIENT_AUTHENTICATION
		}
		var level = connection.smp.currentEncryptionLevel
		switch (perm) {
			case 'encrypted': return 0
			case 'encrypted-mitm': return level.mitm ? 0 : AttErrors.INSUFFICIENT_AUTHENTICATION
			case 'encrypted-mitm-sc': return level.mitm && level.sc ? 0 : AttErrors.INSUFFICIENT_AUTHENTICATION
		}
	}

	function checkReadPermission(item) {
		return checkPerm(item.readPerm, false)
	}

	function checkWritePermission(item) {
		return checkPerm(item.writePerm, true)
	}

	registerOnDataFn(data => {
		if (timedout) {
			return
		}
		if (data.length === 0) {
			// Drop. We can't send Error Response since that needs Request Opcode In Error.
			return
		}
		if (data.length > currentMtu) {
			// Drop, since this is illegal
			return
		}
		var opcode = data[0]
		//console.log('handling ' + opcode)

		if (currentOutgoingRequest !== null && currentOutgoingRequestIsSent && (opcode === currentOutgoingRequest.responseOpcode || opcode === BleGattAttribute.ERROR_RESPONSE)) {
			var cb = currentOutgoingRequest.callback
			if (opcode === BleGattAttribute.ERROR_RESPONSE && data.length !== 5) {
				// Drop invalid PDU
				return
			}
			if (cb) {
				if (opcode === BleGattAttribute.ERROR_RESPONSE && data[4] === 0) {
					// Error code 0 is invalid and not reserved for future use.
					// But it should still be considered an error, so use the Unlikely Error code to get a non-zero code.
					data[4] = AttErrors.UNLIKELY_ERROR
				}
				var err = opcode === BleGattAttribute.ERROR_RESPONSE ? data[4] : 0
				//console.log('executing cb ' + err)
				if (!cb(err, data)) {
					// Drop invalid PDU
					return
				}
			}
			requestTimeoutClearFn()
			var wasMtuExchange = currentOutgoingRequest.responseOpcode === BleGattAttribute.EXCHANGE_MTU_RESPONSE
			currentOutgoingRequest = null
			if (wasMtuExchange) {
				while (notificationQueue.getLength() !== 0) {
					var item = notificationQueue.shift()
					sendDataFn(item.data.slice(0, currentMtu), item.sentCallback, item.completeCallback)
				}
				sendNextIndication()
			}
			sendNextRequest()
			return
		}

		if (isKnownResponseOpcode(opcode)) {
			// Sending unexpected response packet
			return
		}

		if (isHandlingRequest && isKnownRequestOpcode(opcode)) {
			// Client must wait for the response before it sends a new request
			return
		}

		switch (opcode) {
			case BleGattAttribute.EXCHANGE_MTU_REQUEST:
				if (data.length !== 3) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var clientRxMTU = data.readUInt16LE(1)
				if (clientRxMTU < 23) {
					clientRxMTU = 23
				}
				var serverRxMTU = 517
				var combinedMTU = Math.min(clientRxMTU, serverRxMTU)
				sendResponse(Buffer.from([BleGattAttribute.EXCHANGE_MTU_RESPONSE, serverRxMTU, serverRxMTU >> 8]))
				var newMTU = Math.min(clientRxMTU, serverRxMTU)
				if (currentMtu === 23 && newMTU !== 23) {
					currentMtu = newMTU
				}
				return
			case BleGattAttribute.FIND_INFORMATION_REQUEST:
				if (data.length !== 5) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var startingHandle = data.readUInt16LE(1)
				var endingHandle = data.readUInt16LE(3)
				if (startingHandle === 0 || startingHandle > endingHandle) {
					sendErrorResponse(opcode, startingHandle, AttErrors.INVALID_HANDLE)
					return
				}
				endingHandle = Math.min(endingHandle, attDb.length - 1)
				var max16 = (currentMtu - 2) / 2 >>> 0
				var max128 = (currentMtu - 2) / 16 >>> 0
				var format = 0
				var list = []
				for (var i = startingHandle; i <= endingHandle; i++) {
					var item = attDb[i]
					if (item) {
						if (item.uuid16 !== null) {
							if (format === 2 || list.length === max16) {
								break
							}
							format = 1
							list.push({handle: i, uuid16: item.uuid16})
						} else {
							if (format === 1 || list.length === max128) {
								break
							}
							format = 2
							list.push({handle: i, uuid: item.uuid})
						}
					}
				}
				if (format === 0) {
					sendErrorResponse(opcode, startingHandle, AttErrors.ATTRIBUTE_NOT_FOUND)
					return
				}
				var ret = Buffer.alloc(2 + (format === 1 ? 4 : 18) * list.length)
				ret[0] = BleGattAttribute.FIND_INFORMATION_RESPONSE
				ret[1] = format
				var pos = 2
				list.forEach(v => {
					ret.writeUInt16LE(v.handle, pos)
					pos += 2
					if (format === 1) {
						ret.writeUInt16LE(v.uuid16, pos)
						pos += 2
					} else {
						writeUuid128(ret, v.uuid, pos)
						pos += 16
					}
				})
				sendResponse(ret)
				return
			case BleGattAttribute.FIND_BY_TYPE_VALUE_REQUEST:
				if (data.length < 7) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var startingHandle = data.readUInt16LE(1)
				var endingHandle = data.readUInt16LE(3)
				var attributeType = data.readUInt16LE(5)
				var attributeValue = data.slice(7)
				if (startingHandle === 0 || startingHandle > endingHandle) {
					sendErrorResponse(opcode, startingHandle, AttErrors.INVALID_HANDLE)
					return
				}
				endingHandle = Math.min(endingHandle, attDb.length - 1)
				var max = (currentMtu - 1) / 4 >>> 0
				var list = []
				var nextFn = function(i) {
					for (; i <= endingHandle; i++) {
						var item = attDb[i]
						if (item && item.uuid16 === attributeType) {
							var perm = checkReadPermission(item)
							if (perm === 0) {
								item.read(connection, opcode, 0, function(err, value) {
									if (err === 0 && attributeValue.equals(value)) {
										list.push({start: i, end: item.groupEndHandle || i})
										if (list.length === max) {
											doneFn()
											return
										}
									}
									nextFn(i + 1)
								})
								return
							}
						}
					}
					doneFn()
				}
				var doneFn = function() {
					if (list.length === 0) {
						sendErrorResponse(opcode, startingHandle, AttErrors.ATTRIBUTE_NOT_FOUND)
					} else {
						var ret = Buffer.alloc(1 + list.length * 4)
						ret[0] = BleGattAttribute.FIND_BY_TYPE_VALUE_RESPONSE
						var pos = 1
						list.forEach(v => {
							ret.writeUInt16LE(v.start, pos)
							ret.writeUInt16LE(v.end, pos + 2)
							pos += 4
						})
						sendResponse(ret)
					}
				}
				isHandlingRequest = true
				nextFn(startingHandle)
				return
			case BleGattAttribute.READ_BY_TYPE_REQUEST:
				if (data.length !== 7 && data.length !== 21) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var startingHandle = data.readUInt16LE(1)
				var endingHandle = data.readUInt16LE(3)
				var attributeType = getFullUuid(data.length === 7 ? data.readUInt16LE(5) : data.slice(5))
				if (startingHandle === 0 || startingHandle > endingHandle) {
					sendErrorResponse(opcode, startingHandle, AttErrors.INVALID_HANDLE)
					return
				}
				endingHandle = Math.min(endingHandle, attDb.length - 1)
				var requestMtu = currentMtu
				var list = []
				var lastErr = 0
				var errorHandle
				var nextFn = function(i) {
					for (; i <= endingHandle; i++) {
						var item = attDb[i]
						if (item && item.uuid === attributeType) {
							var perm = checkReadPermission(item)
							if (perm !== 0) {
								lastErr = perm
								errorHandle = i
								break
							} else {
								item.read(connection, opcode, 0, function(err, value) {
									if (value) {
										value = value.slice(0, Math.min(253, requestMtu - 4))
									}
									if (err !== 0) {
										lastErr = err
										errorHandle = i
										doneFn()
									} else if ((list.length === 0 || list[0].value.length === value.length) && 2 + (2 + value.length) * (list.length + 1) <= requestMtu) {
										list.push({handle: i, value: Buffer.from(value)})
										nextFn(i + 1)
									} else {
										doneFn()
									}
								})
								return
							}
						}
					}
					doneFn()
				}
				var doneFn = function() {
					if (lastErr !== 0) {
						sendErrorResponse(opcode, errorHandle, lastErr)
					} else if (list.length === 0) {
						sendErrorResponse(opcode, startingHandle, AttErrors.ATTRIBUTE_NOT_FOUND)
					} else {
						var ret = Buffer.alloc(2 + (2 + list[0].value.length) * list.length)
						ret[0] = BleGattAttribute.READ_BY_TYPE_RESPONSE
						ret[1] = 2 + list[0].value.length
						var pos = 2
						list.forEach(v => {
							ret.writeUInt16LE(v.handle, pos)
							v.value.copy(ret, pos + 2)
							pos += 2 + v.value.length
						})
						sendResponse(ret)
					}
				}
				isHandlingRequest = true
				nextFn(startingHandle)
				return
			case BleGattAttribute.READ_REQUEST:
				if (data.length !== 3) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var handle = data.readUInt16LE(1)
				var item = attDb[handle]
				if (!item) {
					sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
					return
				}
				var perm = checkReadPermission(item)
				if (perm !== 0) {
					sendErrorResponse(opcode, handle, perm)
					return
				}
				var requestMtu = currentMtu
				isHandlingRequest = true
				item.read(connection, opcode, 0, function(err, value) {
					if (err !== 0) {
						sendErrorResponse(opcode, handle, err)
					} else {
						if (value) {
							value = value.slice(0, requestMtu - 1)
						}
						var ret = Buffer.alloc(1 + value.length)
						ret[0] = BleGattAttribute.READ_RESPONSE
						value.copy(ret, 1)
						sendResponse(ret)
					}
				})
				return
			case BleGattAttribute.READ_BLOB_REQUEST:
				if (data.length !== 5) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var handle = data.readUInt16LE(1)
				var offset = data.readUInt16LE(3)
				var item = attDb[handle]
				if (!item) {
					sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
					return
				}
				var perm = checkReadPermission(item)
				if (perm !== 0) {
					sendErrorResponse(opcode, handle, perm)
					return
				}
				var requestMtu = currentMtu
				isHandlingRequest = true
				item.read(connection, opcode, offset, function(err, value) {
					if (err !== 0) {
						sendErrorResponse(opcode, handle, err)
					} else {
						if (value) {
							value = value.slice(0, requestMtu - 1)
						}
						var ret = Buffer.alloc(1 + value.length)
						ret[0] = BleGattAttribute.READ_BLOB_RESPONSE
						value.copy(ret, 1)
						sendResponse(ret)
					}
				})
				return
			case BleGattAttribute.READ_MULTIPLE_REQUEST:
				if (data.length < 5 || (data.length - 1) % 2 !== 0) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var handles = []
				for (var i = 1; i < data.length; i += 2) {
					var handle = data.readUInt16LE(i)
					handles.push(handle)
					var item = attDb[handle]
					if (!item) {
						sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
						return
					}
				}
				var requestMtu = currentMtu
				var list = []
				var nextFn = function(i) {
					for (; i < handles.length; i++) {
						var handle = handles[i]
						var item = attDb[handle]
						if (!item) {
							// If att db changes while processing
							sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
							return
						}
						var perm = checkReadPermission(item)
						if (perm !== 0) {
							list.push({err: perm, handle: handle})
						} else {
							item.read(connection, opcode, 0, function(err, value) {
								if (err !== 0) {
									list.push({err: err, handle: handle})
								} else {
									if (value) {
										value = value.slice(0, requestMtu - 1)
									}
									list.push({err: 0, value: Buffer.from(value)})
								}
								nextFn(i + 1)
							})
							return
						}
					}
					var buffers = Buffer.from([BleGattAttribute.READ_MULTIPLE_RESPONSE])
					var firstAuthz = 0, firstAuth = 0, firstEncKeySize = 0, firstEnc = 0, firstReadNotPerm = 0, firstOther = 0, otherErrorType
					list.forEach(v => {
						if (v.err !== 0) {
							if (firstAuthz === 0 && v.err === AttErrors.INSUFFICIENT_AUTHORIZATION) {
								firstAuthz = v.handle
							}
							if (firstAuth === 0 && v.err === AttErrors.INSUFFICIENT_AUTHENTICATION) {
								firstAuth = v.handle
							}
							if (firstEncKeySize === 0 && v.err === AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE) {
								firstEncKeySize = v.handle
							}
							if (firstEnc === 0 && v.err === AttErrors.INSUFFICIENT_ENCRYPTION) {
								firstEnc = v.handle
							}
							if (firstOther === 0) {
								firstOther = v.handle
								otherErrorType = v.err
							}
						} else {
							buffers.push(v.value)
						}
					})
					if (firstAuthz !== 0) {
						sendErrorResponse(opcode, firstAuthz, AttErrors.INSUFFICIENT_AUTHORIZATION)
					} else if (firstAuth !== 0) {
						sendErrorResponse(opcode, firstAuth, AttErrors.INSUFFICIENT_AUTHENTICATION)
					} else if (firstEncKeySize !== 0) {
						sendErrorResponse(opcode, firstEncKeySize, AttErrors.INSUFFICIENT_ENCRYPTION_KEY_SIZE)
					} else if (firstEnc !== 0) {
						sendErrorResponse(opcode, firstEnc, AttErrors.INSUFFICIENT_ENCRYPTION)
					} else if (firstReadNotPerm !== 0) {
						sendErrorResponse(opcode, firstReadNotPerm, AttErrors.READ_NOT_PERMITTED)
					} else if (firstOther !== 0) {
						sendErrorResponse(opcode, firstOther, otherErrorType)
					} else {
						sendResponse(Buffer.concat(buffers).slice(0, requestMtu))
					}
				}
				isHandlingRequest = true
				nextFn(0)
				return
			case BleGattAttribute.READ_BY_GROUP_TYPE_REQUEST:
				if (data.length !== 7 && data.length !== 21) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var startingHandle = data.readUInt16LE(1)
				var endingHandle = data.readUInt16LE(3)
				var attributeGroupType = getFullUuid(data.length === 7 ? data.readUInt16LE(5) : data.slice(5))
				if (startingHandle === 0 || startingHandle > endingHandle) {
					sendErrorResponse(opcode, startingHandle, AttErrors.INVALID_HANDLE)
					return
				}
				endingHandle = Math.min(endingHandle, attDb.length - 1)
				if (attributeGroupType !== '00002800' + BASE_UUID_SECOND_PART && attributeGroupType !== '00002801' + BASE_UUID_SECOND_PART) {
					sendErrorResponse(opcode, startingHandle, AttErrors.UNSUPPORTED_GROUP_TYPE)
					return
				}
				var list = []
				for (var i = startingHandle; i <= endingHandle; i++) {
					var item = attDb[i]
					if (item && item.uuid === attributeGroupType) {
						var value = item.value.slice(0, Math.min(251, currentMtu - 6))
						if (list.length !== 0 && (list[0].value.length !== value.length || 2 + (4 + value.length) * (list.length + 1) > currentMtu)) {
							break
						}

						list.push({start: i, end: item.groupEndHandle || i, value: value})
					}
				}
				if (list.length === 0) {
					sendErrorResponse(opcode, startingHandle, AttErrors.ATTRIBUTE_NOT_FOUND)
					return
				}
				var ret = Buffer.alloc(2 + (4 + list[0].value.length) * list.length)
				ret[0] = BleGattAttribute.READ_BY_GROUP_TYPE_RESPONSE
				ret[1] = 4 + list[0].value.length
				var pos = 2
				list.forEach(v => {
					ret.writeUInt16LE(v.start, pos)
					ret.writeUInt16LE(v.end, pos + 2)
					v.value.copy(ret, pos + 4)
					pos += 4 + v.value.length
				})
				sendResponse(ret)
				return
			case BleGattAttribute.WRITE_REQUEST:
			case BleGattAttribute.WRITE_COMMAND:
				var isCommand = opcode === BleGattAttribute.WRITE_COMMAND
				if (data.length < 3) {
					isCommand || sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var handle = data.readUInt16LE(1)
				var value = data.slice(3)
				var item = attDb[handle]
				if (!item) {
					isCommand || sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
					return
				}
				var perm = checkWritePermission(item)
				if (perm !== 0) {
					isCommand || sendErrorResponse(opcode, handle, perm)
					return
				}
				if (!isCommand) {
					isHandlingRequest = true
				}
				item.authorizeWrite(connection, opcode, 0, Buffer.from(value), function(err) {
					if (connection.disconnected) {
						return
					}
					if (err) {
						if (!isCommand) {
							sendErrorResponse(opcode, handle, err)
						}
					} else {
						if (value.length > item.maxLength) {
							sendErrorResponse(opcode, handle, AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
							return
						}
						item.write(connection, opcode, 0, value, function(err) {
							if (!isCommand) {
								if (err) {
									sendErrorResponse(opcode, handle, err)
								} else {
									sendResponse(Buffer.from([BleGattAttribute.WRITE_RESPONSE]))
								}
							}
						})
					}
				})
				return
			case BleGattAttribute.PREPARE_WRITE_REQUEST:
				if (data.length < 5) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var handle = data.readUInt16LE(1)
				var offset = data.readUInt16LE(3)
				var value = data.slice(5)
				var item = attDb[handle]
				if (!item) {
					sendErrorResponse(opcode, handle, AttErrors.INVALID_HANDLE)
					return
				}
				var perm = checkWritePermission(item)
				if (perm !== 0) {
					sendErrorResponse(opcode, handle, perm)
					return
				}
				isHandlingRequest = true
				if (prepareWriteQueueSize >= 128) {
					sendErrorResponse(opcode, handle, AttErrors.PREPARE_QUEUE_FULL)
					return
				}
				item.authorizeWrite(connection, opcode, offset, Buffer.from(value), function(err) {
					if (err) {
						sendErrorResponse(opcode, handle, err)
					} else {
						++prepareWriteQueueSize
						if (prepareWriteQueue.length > 0) {
							var elem = prepareWriteQueue[prepareWriteQueue.length - 1]
							if (elem.handle === handle && elem.offset + elem.data.length === offset) {
								elem.data = Buffer.concat([elem.data, value])
								data[0] = BleGattAttribute.PREPARE_WRITE_RESPONSE
								sendResponse(data)
								return
							}
						}
						prepareWriteQueue.push({item: item, handle: handle, offset: offset, data: value})
						data[0] = BleGattAttribute.PREPARE_WRITE_RESPONSE
						sendResponse(data)
					}
				})
				return
			case BleGattAttribute.EXECUTE_WRITE_REQUEST:
				if (data.length !== 2 || data[1] > 0x01) {
					sendErrorResponse(opcode, 0, AttErrors.INVALID_PDU)
					return
				}
				var flags = data[1]
				if (flags === 0x00 || prepareWriteQueue.length === 0) {
					// Cancel or empty queue
					prepareWriteQueue = []
					prepareWriteQueueSize = 0
					sendResponse(Buffer.from([BleGattAttribute.EXECUTE_WRITE_RESPONSE]))
				} else {
					// Execute
					for (var i = 0; i < prepareWriteQueue.length; i++) {
						var elem = prepareWriteQueue[i]
						if (elem.offset > elem.item.maxLength) {
							prepareWriteQueue = []
							prepareWriteQueueSize = 0
							sendErrorResponse(opcode, elem.handle, AttErrors.INVALID_OFFSET)
							return
						}
						if (elem.offset + elem.data.length > elem.item.maxLength) {
							prepareWriteQueue = []
							prepareWriteQueueSize = 0
							sendErrorResponse(opcode, elem.handle, AttErrors.INVALID_ATTRIBUTE_VALUE_LENGTH)
							return
						}
					}
					isHandlingRequest = true

					var left = prepareWriteQueue.length
					for (var i = 0; i < prepareWriteQueue.length; i++) {
						var elem = prepareWriteQueue[i]
						(function() {
							var used = false
							elem.item.write(connection, opcode, elem.offset, elem.data, function(err) {
								if (used) {
									return
								}
								used = true
								if (left > 0) {
									if (err) {
										prepareWriteQueue = []
										prepareWriteQueueSize = 0
										sendErrorResponse(opcode, elem.handle, err)
										left = 0
									} else if (--left === 0) {
										prepareWriteQueue = []
										prepareWriteQueueSize = 0
										sendResponse(Buffer.from([BleGattAttribute.EXECUTE_WRITE_RESPONSE]))
									}
								}
							})
						})()
					}

					/*var nextFn = function(i) {
						if (i >= prepareWriteQueue.length) {
							prepareWriteQueue = []
							prepareWriteQueueSize = 0
							sendResponse(Buffer.from([BleGattAttribute.EXECUTE_WRITE_RESPONSE]))
							return
						}
						var elem = prepareWriteQueue[i]
						elem.item.write(connection, opcode, elem.offset, elem.data, function(err) {
							if (err) {
								prepareWriteQueue = []
								prepareWriteQueueSize = 0
								sendErrorResponse(opcode, elem.handle, err)
							} else {
								nextFn(i + 1)
							}
						})
					}
					nextFn(0);*/
				}
				return
			case BleGattAttribute.HANDLE_VALUE_NOTIFICATION:
			case BleGattAttribute.HANDLE_VALUE_INDICATION:
				if (data.length < 3) {
					// Drop
					return
				}
				var handle = data.readUInt16LE(1)
				var value = data.slice(3)
				var isIndication = opcode === BleGattAttribute.HANDLE_VALUE_INDICATION
				if (isIndication && hasOutgoingConfirmation) {
					// Client must wait for the confirmation before it sends a new indication
					return
				}
				if (notifyIndicateCallback) {
					var sentConfirmation = false
					notifyIndicateCallback(handle, isIndication, value, function() {
						if (isIndication && !sentConfirmation) {
							sentConfirmation = true
							sendConfirmation()
						}
					})
				} else {
					if (isIndication) {
						sendConfirmation()
					}
				}
				return
			case BleGattAttribute.HANDLE_VALUE_CONFIRMATION:
				if (data.length !== 1 || !currentOutgoingIndication || !currentOutgoingIndicationIsSent) {
					// Drop
					return
				}
				currentOutgoingIndication()
				indicationTimeoutClearFn()
				indicationTimeoutClearFn = null
				currentOutgoingIndication = null
				sendNextIndication()
				return
		}
	})

	function enqueueRequest(data, callback) {
		requestQueue.push({data: data, callback: callback})
		sendNextRequest()
	}

	this.exchangeMtu = function(callback) {
		var clientRxMTU = 517
		enqueueRequest(Buffer.from([BleGattAttribute.EXCHANGE_MTU_REQUEST, clientRxMTU, clientRxMTU >> 8]), function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length !== 3) {
				return false
			}
			var serverRxMTU = Math.max(23, data.readUInt16LE(1))
			var newMTU = Math.min(clientRxMTU, serverRxMTU)
			if (currentMtu === 23 && newMTU !== 23) {
				currentMtu = newMTU
			}
			callback(0)
			return true
		})
	}

	this.findInformation = function(startingHandle, endingHandle, callback) {
		var buffer = Buffer.alloc(5)
		buffer[0] = BleGattAttribute.FIND_INFORMATION_REQUEST
		buffer.writeUInt16LE(startingHandle, 1)
		buffer.writeUInt16LE(endingHandle, 3)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length < 6) {
				return false
			}
			var format = data[1]
			if (format > 0x02) {
				return false
			}
			if ((data.length - 2) % (format === 0x01 ? 4 : 18) !== 0) {
				return false
			}
			var list = []
			for (var i = 2; i < data.length; i += (format === 0x01 ? 4 : 18)) {
				var handle = data.readUInt16LE(i)
				var uuid = getFullUuid(format === 0x01 ? data.readUInt16LE(i + 2) : data.slice(i + 2, i + 18))
				list.push({handle: handle, uuid: uuid})
			}
			callback(0, list)
			return true
		})
	}

	this.findByTypeValue = function(startingHandle, endingHandle, attributeType, attributeValue, callback) {
		var buffer = Buffer.alloc(7 + attributeValue.length)
		buffer[0] = BleGattAttribute.FIND_BY_TYPE_VALUE_REQUEST
		buffer.writeUInt16LE(startingHandle, 1)
		buffer.writeUInt16LE(endingHandle, 3)
		buffer.writeUInt16LE(attributeType, 5)
		attributeValue.copy(buffer, 7)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length < 5) {
				return false
			}
			if ((data.length - 1) % 4 !== 0) {
				return false
			}
			var list = []
			for (var i = 1; i < data.length; i += 4) {
				list.push({
					// Keys named to be compatible with Read By Group Type
					attributeHandle: data.readUInt16LE(i),
					endGroupHandle: data.readUInt16LE(i + 2),
					attributeValue: buffer.slice(7)
				})
			}
			callback(0, list)
			return true
		})
	}

	this.readByType = function(startingHandle, endingHandle, attributeType, callback) {
		var attributeTypeBuffer = serializeUuid(attributeType)
		var buffer = Buffer.alloc(5 + attributeTypeBuffer.length)
		buffer[0] = BleGattAttribute.READ_BY_TYPE_REQUEST
		buffer.writeUInt16LE(startingHandle, 1)
		buffer.writeUInt16LE(endingHandle, 3)
		attributeTypeBuffer.copy(buffer, 5)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length < 4) {
				return false
			}
			var length = data[1]
			if (length < 2 || (data.length - 2) % length !== 0) {
				return false
			}
			var list = []
			for (var i = 2; i < data.length; i += length) {
				list.push({
					attributeHandle: data.readUInt16LE(i),
					attributeValue: data.slice(i + 2, i + length)
				})
			}
			callback(0, list)
			return true
		})
	}

	this.read = function(attributeHandle, callback) {
		enqueueRequest(Buffer.from([BleGattAttribute.READ_REQUEST, attributeHandle, attributeHandle >> 8]), function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			callback(0, data.slice(1))
			return true
		})
	}

	this.readBlob = function(attributeHandle, valueOffset, callback) {
		var buffer = Buffer.alloc(5)
		buffer[0] = BleGattAttribute.READ_BLOB_REQUEST
		buffer.writeUInt16LE(attributeHandle, 1)
		buffer.writeUInt16LE(valueOffset, 3)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			callback(0, data.slice(1))
			return true
		})
	}

	this.readMultiple = function(setOfHandles, callback) {
		var buffer = Buffer.alloc(1 + 2 * setOfHandles)
		buffer[0] = BleGattAttribute.READ_MULTIPLE_REQUEST
		for (var i = 0; i < setOfHandles.length; i++) {
			buffer.writeUInt16LE(handle, 1 + 2 * i)
		}
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			callback(0, data.slice(1))
			return true
		})
	}

	this.readByGroupType = function(startingHandle, endingHandle, attributeGroupType, callback) {
		var attributeGroupTypeBuffer = serializeUuid(attributeGroupType)
		var buffer = Buffer.alloc(5 + attributeGroupTypeBuffer.length)
		buffer[0] = BleGattAttribute.READ_BY_GROUP_TYPE_REQUEST
		buffer.writeUInt16LE(startingHandle, 1)
		buffer.writeUInt16LE(endingHandle, 3)
		attributeGroupTypeBuffer.copy(buffer, 5)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length < 6) {
				return false
			}
			var length = data[1]
			if (length < 4 || (data.length - 2) % length !== 0) {
				return false
			}
			var list = []
			for (var i = 2; i < data.length; i += length) {
				list.push({
					attributeHandle: data.readUInt16LE(i),
					endGroupHandle: data.readUInt16LE(i + 2),
					attributeValue: data.slice(i + 4, i + length)
				})
			}
			callback(0, list)
			return true
		})
	}

	this.write = function(attributeHandle, attributeValue, callback) {
		var buffer = Buffer.alloc(3 + attributeValue.length)
		buffer[0] = BleGattAttribute.WRITE_REQUEST
		buffer.writeUInt16LE(attributeHandle, 1)
		attributeValue.copy(buffer, 3)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length !== 1) {
				return false
			}
			callback(0)
			return true
		})
	}

	this.writeCommand = function(attributeHandle, attributeValue, sentCallback, completeCallback) {
		attributeValue = attributeValue.slice(0, currentMtu - 3)
		var buffer = Buffer.alloc(3 + attributeValue.length)
		buffer[0] = BleGattAttribute.WRITE_COMMAND
		buffer.writeUInt16LE(attributeHandle, 1)
		attributeValue.copy(buffer, 3)
		sendDataFn(buffer, sentCallback, completeCallback)
	}

	this.prepareWrite = function(attributeHandle, valueOffset, partAttributeValue, callback) {
		var buffer = Buffer.alloc(5 + partAttributeValue.length)
		buffer[0] = BleGattAttribute.PREPARE_WRITE_REQUEST
		buffer.writeUInt16LE(attributeHandle, 1)
		buffer.writeUInt16LE(valueOffset, 3)
		partAttributeValue.copy(buffer, 5)
		enqueueRequest(buffer, function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length < 5) {
				return false
			}
			callback(0, buffer.slice(1).equals(data.slice(1)))
			return true
		})
	}

	this.executeWrite = function(isExecute, callback) {
		enqueueRequest(Buffer.from([BleGattAttribute.EXECUTE_WRITE_REQUEST, isExecute ? 0x01 : 0x00]), function(err, data) {
			if (err) {
				callback(err)
				return true
			}
			if (data.length !== 1) {
				return false
			}
			callback(0)
			return true
		})
	}

	this.notify = function(attributeHandle, attributeValue, sentCallback, completeCallback) {
		var buffer = Buffer.alloc(3 + attributeValue.length)
		buffer[0] = BleGattAttribute.HANDLE_VALUE_NOTIFICATION
		buffer.writeUInt16LE(attributeHandle, 1)
		attributeValue.copy(buffer, 3)
		if (currentOutgoingRequest !== null && currentOutgoingRequest.responseOpcode === BleGattAttribute.EXCHANGE_MTU_RESPONSE) {
			notificationQueue.push({data: buffer, sentCallback: sentCallback, completeCallback: completeCallback})
		} else {
			sendDataFn(buffer.slice(0, currentMtu), sentCallback, completeCallback)
		}
	}

	this.indicate = function(attributeHandle, attributeValue, callback) {
		var buffer = Buffer.alloc(3 + attributeValue.length)
		buffer[0] = BleGattAttribute.HANDLE_VALUE_INDICATION
		buffer.writeUInt16LE(attributeHandle, 1)
		attributeValue.copy(buffer, 3)
		indicationQueue.push({data: buffer, callback: callback})
		sendNextIndication()
	}

	this.getCurrentMtu = function() {
		return currentMtu
	}
}

export interface RangeMapItem {
	start: number
	stop: number
	value: any
}

// create class
export interface RangeMap {

}


function RangeMap() {
	// FIXME: maybe create some better tree-based structure to speed up time complexity

	var map = []; // {start, end, value}

	this.get = function(index) {
		for (var i = 0; i < map.length; i++) {
			var item = map[i]
			if (item.start <= index && index <= item.end) {
				return item
			}
		}
		return null
	}

	this.remove = function(index) {
		for (var i = 0; i < map.length; i++) {
			var item = map[i]
			if (item.start <= index && index <= item.end) {
				map.splice(i, 1)
				return
			}
		}
	}

	this.insert = function(start, end, value) {
		var i
		for (i = 0; i < map.length; i++) {
			var item = map[i]
			if (end < item.start) {
				break
			}
		}
		map.splice(i, 0, {start: start, end: end, value: value})
	}

	this.forEach = function(callback) {
		map.forEach(callback)
	}

	this.map = function(callback) {
		return map.map(callback)
	}

	this.getMap = function() { return map; }

	this.toJSON = function() {
		return map
	}
}

function GattClientService() {
}
function GattClientCharacteristic() {
	EventEmitter.call(this)
}
util.inherits(GattClientCharacteristic, EventEmitter)
function GattClientDescriptor() {
}

function GattConnection(connection, attDb, registerOnDataFn, sendDataFn, registerOnBondedFn) {
	EventEmitter.call(this)
	var gatt = this

	var att = new AttConnection(attDb, connection, registerOnDataFn, sendDataFn, notifyIndicateCallback, timeoutCallback)
	var hasExchangedMtu = false
	var requestQueue = new Queue()
	var hasPendingRequest = false
	var inReliableWrite = false
	var enqueuedReliableWrite = 0

	var gattCache
	function clearGattCache() {
		gattCache = {
			hasAllPrimaryServices: false,
			allPrimaryServices: new RangeMap(),
			secondaryServices: new RangeMap(),
			primaryServicesByUUID: Object.create(null)
		}
	}
	clearGattCache()

	function storeGattCache() {
		if (!connection.smp.isBonded) {
			var gattServiceMap = gattCache[fixUuid(0x1801)]
			if (!gattServiceMap) {
				return
			}
			var hasGattService = false
			var foundCharacteristicInService = false
			var prev = 0x0000
			var hasHole = false
			gattServiceMap.forEach(s => {
				if (s.start !== prev + 1) {
					hasHole = true
				}
				if (s.value) {
					hasGattService = true
					if (s.value.characteristics.some(c => c.uuid === fixUuid(0x2a05))) {
						foundCharacteristicInService = true
					}
				}
				prev = s.end
			})
			if (prev !== 0xffff) {
				hasHole = true
			}
			if (hasHole && !hasGattService) {
				// We don't know yet if there exists a GATT service, so don't assume anything yet about whether the Service Changed characteristic exists
				return
			}
			if (hasGattService && foundCharacteristicInService) {
				// Service Changed characteristic exists => we are not allowed to store a cache
				return
			}
		}

		var peerAddress = connection.smp.isBonded ?
			storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress) :
			storage.constructAddress(connection.peerAddressType, connection.peerAddress)
		if (peerAddress.substr(0, 3) === '01:' && ((parseInt(peerAddress.substr(3, 1), 16) - 4) >>> 0) < 4) {
			// Skip random resolvable addresses, since they are generally re-generated all the time
			return
		}

		function mapService(s) {
			return {
				start: s.start,
				end: s.end,
				service: !s.value ? null : {
					uuid: s.value.uuid,
					includedServices: !s.value.includedServices ? null : s.value.includedServices.map(is => { return {
						start: is.start,
						end: is.end,
						uuid: is.uuid
					}}),
					characteristics: !s.value.characteristics ? null : s.value.characteristics.map(c => { return {
						declarationHandle: c.handle,
						end: c.end,
						uuid: c.uuid,
						valueHandle: c.valueHandle,
						properties: c.properties,
						descriptors: !c.descriptors ? null : c.descriptors.map(d => { return {
							handle: d.handle,
							uuid: d.uuid
						}})
					}})
				}
			}
		}

		var obj = {
			hasAllPrimaryServices: gattCache.hasAllPrimaryServices,
			allPrimaryServices: gattCache.allPrimaryServices.map(mapService),
			secondaryServices: gattCache.secondaryServices.map(mapService),
			primaryServicesByUUID: Object.keys(gattCache.primaryServicesByUUID).reduce((o, key) => {
				var v = gattCache.primaryServicesByUUID[key]
				o[key] = v.map(s => {return {start: s.start, end: s.end, exists: !!s.value}})
				return o
			}, {})
		}

		storage.storeGattCache(
			storage.constructAddress(connection.ownAddressType, connection.ownAddress),
			peerAddress,
			connection.smp.isBonded,
			obj
		)
	}
	registerOnBondedFn(storeGattCache)

	function readGattCache() {
		var peerAddress = connection.smp.isBonded ?
			storage.constructAddress(connection.peerIdentityAddressType, connection.peerIdentityAddress) :
			storage.constructAddress(connection.peerAddressType, connection.peerAddress)

		var obj = storage.getGattCache(
			storage.constructAddress(connection.ownAddressType, connection.ownAddress),
			peerAddress
		)
		if (!obj) {
			return
		}

		gattCache.hasAllPrimaryServices = obj.hasAllPrimaryServices

		var handleMap = Object.create(null)
		var visited = []
		[obj.allPrimaryServices, obj.secondaryServices].forEach((services, i) => {
			services.forEach(s => {
				if (!s.service) {
					(i === 0 ? gattCache.allPrimaryServices : gattCache.secondaryServices).insert(s.start, s.end, null)
					return
				}

				var serviceObj = createGattClientService(s.start, s.end, s.service.uuid, services === obj.allPrimaryServices)
				handleMap[s.start] = serviceObj
				visited.push({serviceObj: serviceObj, cachedService: s})
				if (s.service.characteristics) {
					serviceObj.characteristics = []
					s.service.characteristics.forEach(c => {
						var characteristicObj = createCharacteristic(c.declarationHandle, c.properties, c.valueHandle, c.uuid, c.end)
						serviceObj.characteristics.push(characteristicObj)
						if (c.descriptors) {
							characteristicObj.descriptors = []
							c.descriptors.forEach(d => {
								var descriptorObj = createDescriptor(d.handle, d.uuid)
								characteristicObj.descriptors.push(descriptorObj)
							})
						}
					})
				}
			})
		})

		visited.forEach(v => {
			if (v.cachedService.includedServices) {
				v.serviceObj.includedServices = v.cachedService.includedServices.map(include => handleMap[include.start])
			}
		})


		Object.keys(obj.primaryServicesByUUID).forEach(uuid => {
			var map = obj.primaryServicesByUUID[uuid]
			map.forEach(range => {
				if (!range.exists) {
					var map = gattCache.primaryServicesByUUID[uuid]
					if (!map) {
						map = new RangeMap()
						gattCache.primaryServicesByUUID[uuid] = map
					}
					map.insert(range.start, range.end, null)
				}
			})
		})

		//console.log('Gatt cache loaded:')
		//console.log(JSON.stringify(gattCache))
	}
	readGattCache()

	function timeoutCallback() {
		if (gatt.listenerCount('timeout') > 0) {
			gatt.emit('timeout')
		} else {
			connection.disconnect()
		}
	}

	function readShort(obj, handle, callback) {
		callback = fixCallback(obj, callback)
		enqueueRequest(function() {
			att.read(handle, function(err, value) {
				callback(err, value)
				doneNextRequest()
			})
		})
	}
	function readLong(obj, handle, offset, callback) {
		validate(typeof offset === 'number' && offset >= 0 && offset <= 512 && (offset | 0) === offset, 'Invalid offset')
		callback = fixCallback(obj, callback)

		enqueueRequest(function() {
			var buffers = []
			function nextBlob(offset) {
				var mtu = att.getCurrentMtu()
				var cb = function(err, value) {
					if (err) {
						callback(err)
						doneNextRequest()
						return
					}
					buffers.push(value)
					if (value.length === mtu - 1 && offset + value.length < 512) {
						nextBlob(offset + value.length)
					} else {
						callback(0, Buffer.concat(buffers))
						doneNextRequest()
					}
				}
				if (offset === 0) {
					att.read(handle, cb)
				} else {
					att.readBlob(handle, offset, cb)
				}
			}
			nextBlob(offset)
		})
	}
	function write(obj, isDescriptor, handle, value, offset, callback) {
		validate(typeof offset === 'number' && offset >= 0 && offset <= 512 && (offset | 0) === offset, 'Invalid offset')
		validate((value instanceof Buffer) || (typeof value === 'string'), 'Invalid value type')
		validate(!((enqueuedReliableWrite !== 0 || inReliableWrite) && isDescriptor && (offset !== 0 || value.length > att.getCurrentMtu() - 3)), 'Cannot write long descriptor while Reliable Write is activated')
		callback = fixCallback(obj, callback)

		value = Buffer.from(value); // Make an own copy
		validate(offset + value.length <= 512, 'Invalid value length')

		enqueueRequest(function() {
			if (offset === 0 && value.length <= att.getCurrentMtu() - 3 && (!inReliableWrite || isDescriptor)) {
				att.write(handle, value, function(err) {
					callback(err)
					doneNextRequest()
				})
				return
			}
			var atLeastOneSuccess = false
			var startOffset = offset
			function nextPart(offset) {
				if (offset === startOffset + value.length && atLeastOneSuccess) {
					if (inReliableWrite) {
						callback(0)
						doneNextRequest()
					} else {
						att.executeWrite(true, function(err) {
							callback(err)
							doneNextRequest()
						})
					}
				} else {
					var partValue = value.slice(offset - startOffset, offset - startOffset + att.getCurrentMtu() - 5)
					att.prepareWrite(handle, offset, partValue, function(err, ok) {
						if (err) {
							if (atLeastOneSuccess && !inReliableWrite) {
								att.executeWrite(false, function(err2) {
									callback(err)
									doneNextRequest()
								})
							} else {
								callback(err)
								doneNextRequest()
							}
							return
						}
						if (!ok && inReliableWrite) {
							att.executeWrite(false, function(err2) {
								inReliableWrite = false
								callback(-1)
								doneNextRequest()
							})
							return
						}
						atLeastOneSuccess = true
						nextPart(offset + partValue.length)
					})
				}
			}
			nextPart(startOffset)
		})
	}
	function writeWithoutResponse(obj, handle, value, sentCallback, completeCallback) {
		sentCallback = fixCallback(obj, sentCallback)
		completeCallback = fixCallback(obj, completeCallback)
		validate(value instanceof Buffer && value.length <= 512, 'Invalid value')

		att.writeCommand(handle, value.slice(0, att.getCurrentMtu() - 3), sentCallback, completeCallback)
	}

	function setupReadWrite(obj, isDescriptor, handle) {
		obj.read = function(callback) {
			readLong(this, handle, 0, callback)
		}
		obj.readShort = function(callback) {
			readShort(this, handle, callback)
		}
		obj.readLong = function(offset, callback) {
			readLong(this, handle, offset, callback)
		}
		obj.write = function(value, callback) {
			write(this, isDescriptor, handle, value, 0, callback)
		}
		obj.writeLong = function(value, offset, callback) {
			write(this, isDescriptor, handle, value, offset, callback)
		}
		if (!isDescriptor) {
			obj.writeWithoutResponse = function(value, sentCallback, completeCallback) {
				writeWithoutResponse(this, handle, value, sentCallback, completeCallback)
			}
			obj.writeCCCD = function(enableNotifications, enableIndications, callback) {
				callback = fixCallback(obj, callback)
				validate(!enableNotifications || obj.properties['notify'], 'Cannot enable notifications on a characteristic without the notify property.')
				validate(!enableIndications || obj.properties['indicate'], 'Cannot enable indications on a characteristic without the indicate property.')
				obj.discoverDescriptors(function(descriptors) {
					var cccd = descriptors.find(d => d.uuid === fixUuid(0x2902))
					if (cccd) {
						cccd.write(Buffer.from([(enableNotifications ? 1 : 0) | (enableIndications ? 2 : 0), 0]), callback)
					} else {
						callback(AttErrors.ATTRIBUTE_NOT_FOUND)
					}
				})
			}
		}
	}

	function createDescriptor(handle, uuid) {
		var d = new GattClientDescriptor()
		Object.defineProperty(d, 'handle', {
			value: handle,
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(d, 'uuid', {
			value: uuid,
			enumerable: true,
			configurable: false,
			writable: false
		})
		setupReadWrite(d, true, handle)
		return {handle: handle, uuid: uuid, descriptor: d}
	}

	function createCharacteristic(handle, properties, valueHandle, uuid, end) {
		var characteristic = {
			handle: handle,
			properties: properties,
			valueHandle: valueHandle,
			uuid: uuid,
			end: end,
			descriptors: null,
			discoverAllCharacteristicDescriptors: function(callback) {
				if (valueHandle === end) {
					characteristic.descriptors = []
					callback()
					return
				}

				var found = []
				function next(i) {
					att.findInformation(i, end, function(err, list) {
						list = list || []
						var last = i - 1
						var max = 0
						list.forEach(v => {
							max = Math.max(max, v.handle)
							if (v.handle <= last || v.handle > end) {
								// Invalid, drop
								return
							}
							found.push(v)
							last = v.handle
						})
						if (list.length === 0 || last >= end) {
							characteristic.descriptors = found.map(v => createDescriptor(v.handle, v.uuid))
							storeGattCache()
							callback()
						} else {
							next(last + 1)
						}
					})
				}
				next(valueHandle + 1)
			}
		}

		var c = new GattClientCharacteristic()
		characteristic.characteristic = c
		Object.defineProperty(c, 'properties', {
			value: Object.freeze({
				broadcast: (properties & 0x01) !== 0,
				read: (properties & 0x02) !== 0,
				writeWithoutResponse: (properties & 0x04) !== 0,
				write: (properties & 0x08) !== 0,
				notify: (properties & 0x10) !== 0,
				indicate: (properties & 0x20) !== 0,
				authenticatedSignedWrites: (properties & 0x40) !== 0,
				extendedProperties: (properties & 0x80) !== 0
			}),
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(c, 'declarationHandle', {
			value: handle,
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(c, 'valueHandle', {
			value: valueHandle,
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(c, 'uuid', {
			value: uuid,
			enumerable: true,
			configurable: false,
			writable: false
		})
		setupReadWrite(c, false, valueHandle)
		c.discoverDescriptors = function(callback) {
			callback = fixCallback(c, callback)

			if (characteristic.descriptors !== null) {
				callback(characteristic.descriptors.map(v => v.descriptor))
				return
			}
			enqueueRequest(function() {
				if (characteristic.descriptors !== null) {
					callback(characteristic.descriptors.map(v => v.descriptor))
					doneNextRequest()
					return
				}
				characteristic.discoverAllCharacteristicDescriptors(function() {
					callback(characteristic.descriptors.map(v => v.descriptor))
					doneNextRequest()
				})
			})
		}
		return characteristic
	}

	function createGattClientService(start, end, uuid, isPrimary) {
		//console.log('creating ' + start + ', ' + end + ', ' + uuid + ', ' + isPrimary)

		var service = {
			start: start,
			end: end,
			uuid: uuid,
			characteristics: null,
			includedServices: null,
			findIncludedServices: function(callback) {
				var found = []
				function next(i) {
					att.readByType(i, end, 0x2802, function(err, list) {
						list = list || []
						var last = i - 1
						var max = 0
						list.forEach(v => {
							max = Math.max(max, v.attributeHandle)
							if (v.attributeHandle <= last || v.attributeHandle > end || (v.attributeValue.length !== 4 && v.attributeValue !== 6)) {
								// Invalid, drop
								return
							}
							found.push({
								includedServiceAttributeHandle: v.attributeValue.readUInt16LE(0),
								endGroupHandle: v.attributeValue.readUInt16LE(2),
								serviceUUID: v.attributeValue.length === 6 ? getFullUuid(v.attributeValue.readUInt16LE(4)) : null
							})
							last = v.attributeHandle
						})
						if (list.length === 0 || max >= end) {
							function next128(j) {
								while (true) {
									if (j === found.length) {
										service.includedServices = []
										found.filter(v => v.serviceUUID !== null).map(v => {
											var s = gattCache.secondaryServices.get(v.includedServiceAttributeHandle)
											if (!s) {
												s = createGattClientService(v.includedServiceAttributeHandle, v.endGroupHandle, false)
											}
											service.includedServices.push(s)
										})
										storeGattCache()
										callback()
										return
									}
									if (found[j].serviceUUID !== null) {
										j++
									} else {
										break
									}
								}
								att.read(found[j].includedServiceAttributeHandle, function(err, value) {
									if (!err && value.length === 16) {
										found[j].serviceUUID = getFullUuid(value)
									}
									next128(j + 1)
								})
							}
							next128(0)
						} else {
							next(last + 1)
						}
					})
				}
				next(start)
			},
			discoverAllCharacteristics: function(callback) {
				var found = []
				function next(i) {
					att.readByType(i, end, 0x2803, function(err, list) {
						list = list || []
						var last = i - 1
						var max = 0
						list.forEach(v => {
							max = Math.max(max, v.attributeHandle)
							if (v.attributeHandle <= last || v.attributeHandle > end || (v.attributeValue.length !== 5 && v.attributeValue.length !== 19)) {
								// Invalid, drop
								return
							}
							found.push({
								declarationHandle: v.attributeHandle,
								properties: v.attributeValue[0],
								valueHandle: v.attributeValue.readUInt16LE(1),
								uuid: getFullUuid(v.attributeValue.slice(3))
							})
							last = v.attributeHandle
						})
						if (list.length === 0 || max >= end) {
							service.characteristics = []
							for (var j = 0; j < found.length; j++) {
								var endingHandle = j + 1 < found.length ? found[j + 1].declarationHandle - 1 : end
								var v = found[j]
								service.characteristics.push(createCharacteristic(v.declarationHandle, v.properties, v.valueHandle, v.uuid, endingHandle))
							}
							storeGattCache()
							callback()
						} else {
							next(last + 1)
						}
					})
				}
				next(start)
			}
		}
		var s = new GattClientService()
		service.service = s
		Object.defineProperty(s, 'startHandle', {
			value: start,
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(s, 'endHandle', {
			value: end,
			enumerable: true,
			configurable: false,
			writable: false
		})
		Object.defineProperty(s, 'uuid', {
			value: uuid,
			enumerable: true,
			configurable: false,
			writable: false
		})
		s.findIncludedServices = function(callback) {
			callback = fixCallback(s, callback)

			if (service.includedServices) {
				callback(service.includedServices.map(s => s.service))
				return
			}
			enqueueRequest(function() {
				if (service.includedServices) {
					callback(service.includedServices.map(s => s.service))
					doneNextRequest()
					return
				}
				service.findIncludedServices(function() {
					callback(service.includedServices.map(s => s.service))
					doneNextRequest()
				})
			})
		}
		s.discoverCharacteristics = function(callback) {
			callback = fixCallback(s, callback)

			if (service.characteristics) {
				callback(service.characteristics.map(v => v.characteristic))
				return
			}
			enqueueRequest(function() {
				if (service.characteristics) {
					callback(service.characteristics.map(v => v.characteristic))
					doneNextRequest()
					return
				}
				service.discoverAllCharacteristics(function() {
					callback(service.characteristics.map(v => v.characteristic))
					doneNextRequest()
				})
			})
		}
		if (isPrimary) {
			gattCache.allPrimaryServices.insert(start, end, service)
			var map = gattCache.primaryServicesByUUID[uuid]
			if (!map) {
				map = new RangeMap()
				gattCache.primaryServicesByUUID[uuid] = map
			}
			map.insert(start, end, service)
		} else {
			gattCache.secondaryServices.insert(start, end, service)
		}
		return service
	}

	function discoverPrimaryServices(uuid, numToFind, callback) {
		callback = fixCallback(this, callback)

		function execute(inRequest) {
			if (gattCache.hasAllPrimaryServices) {
				var result = []
				gattCache.allPrimaryServices.forEach(v => {
					if (v.value !== null && (!uuid || v.value.uuid === uuid)) {
						result.push(v.value.service)
					}
				})
				callback(result)
				if (inRequest) {
					doneNextRequest()
				}
				return
			}
			var map
			if (!uuid) {
				map = gattCache.allPrimaryServices
			} else {
				map = gattCache.primaryServicesByUUID[uuid]
				if (!map) {
					map = new RangeMap()
					gattCache.primaryServicesByUUID[uuid] = map
				}
			}
			var rangesToCheck = []

			var numFound = 0
			var last = 0
			map.forEach(item => {
				if (item.value !== null) {
					++numFound
				}
				if (item.start > last + 1) {
					rangesToCheck.push({start: last + 1, end: item.start - 1})
				}
				last = item.end
			})
			if (last !== 0xffff) {
				rangesToCheck.push({start: last + 1, end: 0xffff})
			}
			if (!inRequest && rangesToCheck.length !== 0) {
				enqueueRequest(function() {
					execute(true)
				})
				return
			}
			function next(i, maxCheckedHandle) {
				if (i === rangesToCheck.length || numFound >= numToFind) {
					if (maxCheckedHandle !== 0) {
						// We have now checked the whole range (up to maxCheckedHandle), so mark potential holes as not unknown anymore
						function fillHoles(map) {
							//console.log('before', map.getMap())
							var last = 0
							var holes = []
							map.forEach(item => {
								if (item.start > maxCheckedHandle) {
									return
								}
								if (item.start > last + 1) {
									holes.push({start: last + 1, end: item.start - 1})
								}
								last = item.end
							})
							if (last < maxCheckedHandle) {
								holes.push({start: last + 1, end: maxCheckedHandle})
							}
							holes.forEach(v => {
								map.insert(v.start, v.end, null)
							})
							//console.log('after', map.getMap())
						}
						fillHoles(map)
						if (!uuid) {
							for (var uuidKey in gattCache.primaryServicesByUUID) {
								fillHoles(gattCache.primaryServicesByUUID[uuidKey])
							}
							if (numToFind >= 0xffff) {
								gattCache.hasAllPrimaryServices = true
							}
						}
					}
					storeGattCache()
					var result = []
					map.forEach(v => {
						if (v.value !== null) {
							result.push(v.value.service)
						}
					})
					callback(result)
					if (inRequest) {
						doneNextRequest()
					}
					return
				}
				function nextSubRange(startingHandle) {
					var cb = function(err, list) {
						list = list || []
						var end = startingHandle - 1
						var last = startingHandle - 1
						list.forEach(v => {
							end = Math.max(end, v.endGroupHandle)
							var uuid = getFullUuid(v.attributeValue)
							if (!uuid || v.attributeHandle <= last || v.attributeHandle > v.endGroupHandle || v.endGroupHandle > rangesToCheck[i].end) {
								// Invalid, drop item (the last case is really not invalid, but ignore anyway since it doesn't match our previous cache)
								return
							}
							if (!gattCache.allPrimaryServices.get(v.attributeHandle)) {
								var s = gattCache.secondaryServices.get(v.attributeHandle)
								if (s) {
									gattCache.allPrimaryServices.insert(s.start, s.end, s)
									gattCache.secondaryServices.remove(s.start)
								} else {
									createGattClientService(v.attributeHandle, v.endGroupHandle, uuid, true)
								}
							}
							++numFound
							last = v.endGroupHandle
						})
						if (list.length === 0 || end >= rangesToCheck[i].end || numFound >= numToFind) {
							next(i + 1, list.length === 0 ? rangesToCheck[i].end : end)
						} else {
							nextSubRange(end + 1)
						}
					}
					if (uuid) {
						att.findByTypeValue(startingHandle, rangesToCheck[i].end, 0x2800, serializeUuid(uuid), cb)
					} else {
						att.readByGroupType(startingHandle, rangesToCheck[i].end, 0x2800, cb)
					}
				}
				nextSubRange(rangesToCheck[i].start)
			}
			next(0, 0)
		}

		execute(false)
	}

	function nextRequest() {
		if (!hasPendingRequest) {
			var fn = requestQueue.shift()
			if (fn) {
				hasPendingRequest = true
				fn()
			}
		}
	}

	function doneNextRequest() {
		hasPendingRequest = false
		nextRequest()
	}

	function enqueueRequest(fn) {
		requestQueue.push(fn)
		nextRequest()
	}

	function notifyIndicateCallback(handle, isIndication, value, callback) {
		var service = gattCache.allPrimaryServices.get(handle) || gattCache.secondaryServices.get(handle)
		if (service && service.value.characteristics !== null) {
			var cs = service.value.characteristics
			for (var i = 0; i < cs.length; i++) {
				if (cs[i].valueHandle === handle) {
					var c = cs[i].characteristic
					var lc = c.listenerCount('change')
					if (lc === 0) {
						break
					}
					c.emit('change', value, isIndication, callback)
					return
				}
			}
		}
		callback()
		return
	}

	this.exchangeMtu = function(callback) {
		callback = fixCallback(this, callback)
		validate(!hasExchangedMtu, 'Has already exchanged MTU')

		hasExchangedMtu = true

		enqueueRequest(function() {
			att.exchangeMtu(function(err) {
				callback(err)
				doneNextRequest()
			})
		})
	}

	this.beginReliableWrite = function() {
		++enqueuedReliableWrite
		enqueueRequest(function() {
			--enqueuedReliableWrite
			inReliableWrite = true
			doneNextRequest()
		})
	}

	this.cancelReliableWrite = function(callback) {
		callback = fixCallback(this, callback)

		enqueueRequest(function() {
			att.executeWrite(false, function(err) {
				inReliableWrite = false
				callback(err)
				doneNextRequest()
			})
		})
	}

	this.commitReliableWrite = function(callback) {
		callback = fixCallback(this, callback)

		enqueueRequest(function() {
			att.executeWrite(true, function(err) {
				inReliableWrite = false
				callback(err)
				doneNextRequest()
			})
		})
	}

	this.discoverAllPrimaryServices = function(callback) {
		callback = fixCallback(this, callback)
		discoverPrimaryServices(null, 0xffff, callback)
	}

	this.discoverServicesByUuid = function(uuid, numToFind, callback) {
		uuid = fixUuid(uuid)
		validate(typeof numToFind === 'undefined' || (Number.isInteger(numToFind) && numToFind >= 0), 'Invalid numToFind. Must be either undefined or a non-negative integer.')
		if (typeof numToFind === 'undefined') {
			numToFind = 0xffff
		}
		callback = fixCallback(this, callback)

		discoverPrimaryServices(uuid, numToFind, callback)
	}

	this.readUsingCharacteristicUuid = function(startHandle, endHandle, uuid, callback) {
		validate(Number.isInteger(startHandle) && startHandle >= 0x0001 && startHandle <= 0xffff, 'Invalid startHandle. Must be an integer between 0x0001 and 0xffff.')
		validate(Number.isInteger(endHandle) && endHandle >= 0x0001 && endHandle <= 0xffff, 'Invalid endHandle. Must be an integer between 0x0001 and 0xffff.')
		validate(startHandle <= endHandle, 'The startHandle must not be larger than the endHandle.')
		uuid = fixUuid(uuid)
		callback = fixCallback(this, callback)

		enqueueRequest(startHandle, endHandle, uuid, function() {
			att.readByType(function(err, list) {
				callback(err, list)
				doneNextRequest()
			})
		})
	}

	this.invalidateServices = function(startHandle, endHandle, callback) {
		validate(Number.isInteger(startHandle) && startHandle >= 0x0001 && startHandle <= 0xffff, 'Invalid startHandle. Must be an integer between 0x0001 and 0xffff.')
		validate(Number.isInteger(endHandle) && endHandle >= 0x0001 && endHandle <= 0xffff, 'Invalid endHandle. Must be an integer between 0x0001 and 0xffff.')
		validate(startHandle <= endHandle, 'The startHandle must not be larger than the endHandle.')
		callback = fixCallback(this, callback)

		enqueueRequest(function() {
			var modified = false
			if (startHandle === 0x0001 && endHandle === 0xffff) {
				clearGattCache()
				modified = true
			} else {
				var maps = [gattCache.allPrimaryServices, gattCache.secondaryServices]
				for (var uuidKey in gattCache.primaryServicesByUUID) {
					maps.push(gattCache.primaryServicesByUUID)
				}
				maps.forEach(map => {
					var toRemove = []
					map.forEach(v => {
						if (v.start <= endHandle && v.end >= startHandle) {
							toRemove.push(v.start)
						}
					})
					toRemove.forEach(handle => {
						map.remove(handle)
						modified = true
					})
				})

				// If the handles of an included service has been modified, invalidate the entry in the original service and create a new,
				// forcing rediscovery of its included services, characteristics and descriptors.
				// Assume that the start, end, uuid of the included has not been modified, since otherwise the enclosing service should have
				// been included in the invalidated range also.
				[gattCache.allPrimaryServices, gattCache.secondaryServices].forEach(map => {
					map.forEach(v => {
						if (v.includedServices !== null) {
							for (var i = 0; i < v.includedServices.length; i++) {
								var s = v.includedServices[i]
								if (s.start <= endHandle && s.end >= startHandle) {
									v.includedServices[i] = createGattClientService(s.start, s.end, s.uuid, false)
									// assert (modified === true)
								}
							}
						}
					})
				})
			}
			if (modified) {
				hasAllPrimaryServices = false
				storeGattCache()
			}
			callback()
			doneNextRequest()
		})
	}

	Object.defineProperty(this, 'currentMtu', {enumerable: true, configurable: false, get: () => att.getCurrentMtu()})

	Object.defineProperty(this, '_notify', {enumerable: false, configurable: false, writable: false, value: function(attributeHandle, attributeValue, sentCallback, completeCallback) {
		att.notify(attributeHandle, attributeValue, sentCallback, completeCallback)
	}})
	Object.defineProperty(this, '_indicate', {enumerable: false, configurable: false, writable: false, value: function(attributeHandle, attributeValue, callback) {
		att.indicate(attributeHandle, attributeValue, callback)
	}})
}
util.inherits(GattConnection, EventEmitter)

module.exports = Object.freeze({
	GattConnection: GattConnection,
	GattServerDb: GattServerDb
})

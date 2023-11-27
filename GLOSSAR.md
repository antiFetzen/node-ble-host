# Glossar

## LTK
LongTermKey

## IRK
Identity Resolving Key

## EDIV
Encrypted Diversifier (EDIV) is a 16-bit stored value used to identify the LTK distributed during LE legacy pairing. A new EDIV is generated each time a unique LTK is distributed.

## RAND
Random Number (Rand) is a 64-bit stored valued used to identify the LTK distributed during LE legacy pairing. A new Rand is generated each time a unique LTK is distributed.

## MITM
MITM is short for “Man-In-The-Middle.” This field is a 1-bit flag that is set to one if the device is requesting MITM protection. This blog focuses on the procedure for the pairing feature exchange—if you are interested in MITM, please refer to the Bluetooth Core Specification v4.2, Vol1, Part A, 5.2.3.

## SC
The SC field is a 1-bit flag that is set to one to request LE Secure Connection pairing. The possible resulting pairing mechanisms are if both devices support LE Secure Connections, use LE Secure Connections and otherwise use LE legacy pairing. So this flag is an indicator to determine Phase 2 pairing method.

## CCCD
Client Characteristic Configuration Descriptor (CCCD) allows a remote device to enable or disable the



source: https://www.bluetooth.com/blog/bluetooth-pairing-part-1-pairing-feature-exchange/

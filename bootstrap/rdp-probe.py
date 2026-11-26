"""Read the RDP endpoint certificate; never submit credentials or open a desktop."""
import hashlib
import socket
import ssl
import sys

def receive(sock, size):
    data = b""
    while len(data) < size:
        block = sock.recv(size - len(data))
        if not block:
            raise ValueError("short reply")
        data += block
    return data

def fingerprint(address, port):
    with socket.create_connection((address, port), timeout=4) as sock:
        # X.224 Connection Request offering SSL and HYBRID (CredSSP).
        sock.sendall(bytes.fromhex("030000130ee000000000000100080003000000"))
        header = receive(sock, 4)
        if header != bytes.fromhex("03000013"):
            raise ValueError("unexpected TPKT")
        reply = receive(sock, 15)
        if reply[:2] != b"\x0e\xd0" or reply[7] != 2 or reply[9:11] != b"\x08\x00" or int.from_bytes(reply[11:], "little") not in (1, 2):
            raise ValueError("RDP did not select TLS")
        # The caller pins the DER fingerprint against the enrolled worker.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with context.wrap_socket(sock) as tls:
            return hashlib.sha256(tls.getpeercert(binary_form=True)).digest().hex(":")

if __name__ == "__main__":
    try:
        print(fingerprint(sys.argv[1], int(sys.argv[2])))
    except (OSError, ValueError):
        sys.exit(1)

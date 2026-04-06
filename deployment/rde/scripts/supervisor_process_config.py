#!/usr/bin/env python3
"""Fetch one process config from supervisord via XML-RPC (getAllConfigInfo)."""
import configparser
import http.client
import json
import os
import socket
import sys
import xmlrpc.client


class UnixStreamHTTPConnection(http.client.HTTPConnection):
    def __init__(self, unix_path: str) -> None:
        super().__init__("localhost")
        self.unix_path = unix_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.unix_path)


class UnixStreamTransport(xmlrpc.client.Transport):
    def __init__(self, unix_path: str) -> None:
        super().__init__(use_datetime=True)
        self.unix_path = unix_path

    def make_connection(self, host):  # noqa: ARG002
        return UnixStreamHTTPConnection(self.unix_path)


def _socket_path() -> str:
    cfg = configparser.ConfigParser()
    cfg.read("/etc/supervisor/supervisord.conf")
    try:
        return cfg.get("unix_http_server", "file").strip()
    except (configparser.NoSectionError, configparser.NoOptionError):
        pass
    for fallback in (
        "/var/run/supervisor.sock",
        "/var/run/supervisord.sock",
        "/tmp/supervisor.sock",
    ):
        if os.path.exists(fallback):
            return fallback
    return "/var/run/supervisor.sock"


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing_process_name"}))
        sys.exit(2)
    process_name = sys.argv[1]
    sock = _socket_path()
    transport = UnixStreamTransport(sock)
    proxy = xmlrpc.client.ServerProxy("http://127.0.0.1/RPC2", transport=transport)

    try:
        configs = proxy.supervisor.getAllConfigInfo()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "getAllConfigInfo_failed", "detail": str(e)}))
        sys.exit(1)

    for row in configs:
        if row.get("name") == process_name:
            print(json.dumps(row, default=str))
            return

    print(json.dumps({"error": "not_found", "name": process_name}))
    sys.exit(1)


if __name__ == "__main__":
    main()

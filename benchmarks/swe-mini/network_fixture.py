"""Restore the Requests suite's unroutable TARPIT in the scorer's network namespace."""

ROUTE_SCRIPT = r'''
import socket, struct
# A host route with link scope makes this off-subnet address resolve by ARP
# inside this disposable Docker namespace, rather than using the host gateway.
destination = socket.inet_aton("10.255.255.1")
interface = socket.if_nametoindex("eth0")
route = struct.pack("BBBBBBBBI", socket.AF_INET, 32, 0, 0, 254, 4, 253, 1, 0)
route += struct.pack("HH", 8, 1) + destination
route += struct.pack("HHI", 8, 4, interface)
message = struct.pack("IHHII", 16 + len(route), 24, 0x505, 1, 0) + route
with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE) as netlink:
    netlink.bind((0, 0))
    netlink.settimeout(5)
    netlink.send(message)
    response = netlink.recv(4096)
    if struct.unpack_from("H", response, 4)[0] != 2:
        raise RuntimeError("Missing route acknowledgement")
    error = struct.unpack_from("i", response, 16)[0]
    if error:
        raise OSError(-error, "Cannot configure scorer TARPIT route")
# Refuse the fixture if the intended TCP connect timeout is not reproduced.
with socket.socket() as probe:
    probe.settimeout(0.1)
    try:
        probe.connect(("10.255.255.1", 80))
    except socket.timeout:
        print("SCORER_TARPIT_CONNECT_TIMEOUT_OK", flush=True)
    else:
        raise RuntimeError("Scorer TARPIT unexpectedly accepted TCP")
'''


def configure_network_fixture(spec, repo):
    if repo != "psf/requests":
        return
    spec.docker_specs = dict(spec.docker_specs)
    args = dict(spec.docker_specs.get("run_args", {}))
    args["cap_add"] = list(dict.fromkeys([*args.get("cap_add", []), "NET_ADMIN"]))
    spec.docker_specs["run_args"] = args
    setup = "/opt/miniconda3/bin/python - <<'PICODE_NETWORK_FIXTURE'\n" + ROUTE_SCRIPT + "\nPICODE_NETWORK_FIXTURE\nif [ $? -ne 0 ]; then exit 97; fi"
    spec.eval_script_list = [setup, *spec.eval_script_list]


def check_fixture_result(result, repo, output):
    if repo == "psf/requests" and "SCORER_TARPIT_CONNECT_TIMEOUT_OK" not in output.splitlines():
        return dict(result, completed=False, resolved=False, failureKind="network_fixture")
    return result


if __name__ == '__main__':
    exec(ROUTE_SCRIPT)

# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Bootstrap minting: --list or --field NAME. Secret output is for the caller.

The provisioning credential only mints replacements. Save the new value,
deploy and verify before retiring the previous token by its provider ID.
"""
import os
import secrets
import subprocess
import sys
from uuid import uuid4

import httpx

NAME = "bookmarks-sync"
OP_CF_TOKEN = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"
FIELDS = ["api-token", "account-id", "SYNC_TOKEN"]


def log(message: str) -> None:
    print(message, file=sys.stderr)


def op_read(ref: str) -> str:
    return subprocess.run(["op", "read", ref], capture_output=True, text=True, check=True).stdout.strip()


def client() -> httpx.Client:
    return httpx.Client(
        base_url="https://api.cloudflare.com/client/v4",
        headers={"Authorization": "Bearer " + (os.environ.get("CF_PROVISION_TOKEN") or op_read(OP_CF_TOKEN))},
        timeout=30,
    )


def account_id(c: httpx.Client) -> str:
    if value := os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        return value
    accounts = c.get("/accounts").raise_for_status().json()["result"]
    if len(accounts) != 1:
        raise RuntimeError("Set CLOUDFLARE_ACCOUNT_ID to select the deployment account")
    return accounts[0]["id"]


def mint_deploy_token() -> str:
    """Dedicated credential; Workers Scripts Write is account-wide in Cloudflare."""
    with client() as c:
        groups = c.get("/user/tokens/permission_groups").raise_for_status().json()["result"]
        ids = {g["name"]: g["id"] for g in groups}
        policies = [{
            "effect": "allow",
            "resources": {f"com.cloudflare.api.account.{account_id(c)}": "*"},
            "permission_groups": [{"id": ids["Workers Scripts Write"]}],
        }]
        result = c.post("/user/tokens", json={
            "name": f"{NAME}-deploy-{uuid4().hex[:8]}",
            "policies": policies,
        }).raise_for_status().json()
        if not result.get("success"):
            raise RuntimeError("Cloudflare refused the deployment credential")
        log(f"Minted deployment token {result['result']['id']}; previous tokens remain active until verification")
        return result["result"]["value"]


def deployment_account() -> str:
    with client() as c:
        return account_id(c)


MINTERS = {
    "api-token": mint_deploy_token,
    "account-id": deployment_account,
    "SYNC_TOKEN": lambda: secrets.token_urlsafe(32),
}


def main() -> None:
    if sys.argv[1:] == ["--list"]:
        print("\n".join(FIELDS))
    elif len(sys.argv) == 3 and sys.argv[1] == "--field" and sys.argv[2] in FIELDS:
        print(MINTERS[sys.argv[2]]())
    else:
        sys.exit(f"usage: provision.py --list | --field {{{','.join(FIELDS)}}}")


if __name__ == "__main__":
    main()

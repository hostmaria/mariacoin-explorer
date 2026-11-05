#!/usr/bin/env python3
"""Render root-controlled eIquidus settings without exposing secrets in argv."""
import argparse
import json
import os
import re
from pathlib import Path
import secrets


GENESIS_BLOCK = "0000040cb60b26f13ffcd2f692d679e172da34096041efe215d8c50cd65dd9f9"
GENESIS_TX = "5e82501aa4f898173ca938fef4d080f25969109efd7b790fe323bcff9f16dc04"


def strip_json_comments(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
        elif char == '"':
            in_string = True
            output.append(char)
            index += 1
        elif text.startswith("//", index):
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise SystemExit("unterminated block comment in settings template")
            index = end + 2
        else:
            output.append(char)
            index += 1
    if in_string:
        raise SystemExit("unterminated string in settings template")
    return "".join(output)


def disable_api_tree(node: object) -> None:
    if isinstance(node, dict):
        if "enabled" in node:
            node["enabled"] = False
        for value in node.values():
            disable_api_tree(value)
    elif isinstance(node, list):
        for value in node:
            disable_api_tree(value)


def configure_mariacoin(settings: dict) -> None:
    settings["coin"] = {"name": "MariaCoin", "symbol": "$maria"}
    settings.setdefault("network_history", {})["enabled"] = False
    network_page = settings.setdefault("network_page", {})
    network_page["enabled"] = True
    network_page.setdefault("connections_table", {}).update({"enabled": True, "port_filter": -1})
    network_page.setdefault("addnodes_table", {})["enabled"] = False
    network_page.setdefault("onetry_table", {})["enabled"] = False
    settings.setdefault("sync", {})["peer_geolocation_enabled"] = True

    shared = settings.setdefault("shared_pages", {})
    shared.update({
        "theme": "Darkly",
        "page_title": "MariaCoin Explorer",
        "logo": "/img/maria-logo.png",
        "show_hashrate": False,
        "difficulty": "POS",
        "confirmations": 20,
    })
    header = shared.setdefault("page_header", {})
    header.update({"home_link": "logo", "home_link_logo": "/img/maria-logo.png", "home_link_logo_height": 50})
    header.setdefault("page_title_image", {}).update({"image_path": "/img/mariacoin-logo-square.png", "enable_animation": False})
    header.setdefault("network_charts", {}).setdefault("nethash_chart", {})["enabled"] = False
    footer = shared.setdefault("page_footer", {})
    footer["social_links"] = []
    panels = header.setdefault("panels", {})
    for name in ("network_panel", "difficulty_panel", "price_panel", "usd_price_panel", "market_cap_panel", "usd_market_cap_panel"):
        panels.setdefault(name, {})["enabled"] = False
        panels[name]["display_order"] = 0
    panels.setdefault("coin_supply_panel", {}).update({"enabled": True, "display_order": 1})
    panels.setdefault("masternodes_panel", {}).update({"enabled": True, "display_order": 2})

    settings.setdefault("block_page", {})["genesis_block"] = GENESIS_BLOCK
    settings.setdefault("transaction_page", {})["genesis_tx"] = GENESIS_TX
    settings.setdefault("masternodes_page", {})["enabled"] = True
    settings.setdefault("markets_page", {})["enabled"] = False
    claim_address_page = settings.setdefault("claim_address_page", {})
    claim_address_page["enabled"] = True
    claim_address_page["show_header_menu"] = True
    claim_address_page["enable_bad_word_filter"] = False
    claim_address_page["enable_captcha"] = False
    settings.setdefault("richlist_page", {}).setdefault("burned_coins", {})["addresses"] = []
    settings["default_coingecko_ids"] = []

    api_page = settings.setdefault("api_page", {})
    api_page["enabled"] = True
    public = api_page.setdefault("public_apis", {})
    disable_api_tree(public)
    public.setdefault("rpc", {}).setdefault("getblockcount", {})["enabled"] = True
    public.setdefault("ext", {}).setdefault("getmoneysupply", {})["enabled"] = True

    settings["api_cmds"] = {
        "use_rpc": True,
        "rpc_concurrent_tasks": 4,
        "getnetworkhashps": "getnetworkhashps",
        "getmininginfo": "getmininginfo",
        "getdifficulty": "getdifficulty",
        "getconnectioncount": "getconnectioncount",
        "getblockcount": "getblockcount",
        "getblockhash": "getblockhash",
        "getblock": "getblock",
        "getrawtransaction": "getrawtransaction",
        "getinfo": "getinfo",
        "getblockchaininfo": "getblockchaininfo",
        "getpeerinfo": "getpeerinfo",
        "gettxoutsetinfo": "gettxoutsetinfo",
        "getvotelist": "masternodelist votes",
        "getmasternodecount": "getmasternodecount",
        "getmasternodelist": "listmasternodes",
        "verifymessage": "verifymessage",
    }
    settings.setdefault("wallet", {})["timeout"] = 60000
    blockchain = settings.setdefault("blockchain_specific", {})
    blockchain.setdefault("bitcoin", {})["enabled"] = False
    blockchain.setdefault("heavycoin", {})["enabled"] = False
    blockchain["heavycoin"].setdefault("reward_page", {})["enabled"] = False
    disable_api_tree(blockchain["heavycoin"].setdefault("public_apis", {}))
    blockchain.setdefault("zksnarks", {})["enabled"] = False
    settings.setdefault("sync", {}).update({"block_parallel_tasks": 1, "supply": "GETINFO", "wait_for_bulk_database_save": True})


def rpc_values(path: Path) -> dict[str, str]:
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    for key in ("rpcuser", "rpcpassword"):
        if not values.get(key):
            raise SystemExit(f"missing {key} in RPC configuration")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--rpc-config", type=Path, required=True)
    parser.add_argument("--mongodb-credentials", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--explorer-host-file", type=Path, default=Path("/etc/eiquidus/explorer-host"))
    args = parser.parse_args()

    settings = json.loads(strip_json_comments(args.template.read_text(encoding="utf-8")))
    configure_mariacoin(settings)
    rpc = rpc_values(args.rpc_config)
    mongo = json.loads(args.mongodb_credentials.read_text(encoding="utf-8"))
    if not all(mongo.get(key) for key in ("username", "password", "database")):
        raise SystemExit("incomplete MongoDB credentials")

    settings.setdefault("wallet", {}).update({
        "host": "127.0.0.1", "port": 47774,
        "username": rpc["rpcuser"], "password": rpc["rpcpassword"],
    })
    settings.setdefault("dbsettings", {}).update({
        "address": "127.0.0.1", "port": 27017,
        "user": mongo["username"], "password": mongo["password"],
        "database": mongo["database"],
    })
    web = settings.setdefault("webserver", {})
    web["port"] = 3001
    web.setdefault("tls", {})["enabled"] = False
    web.setdefault("cors", {})["enabled"] = False
    settings.setdefault("api_page", {})["enabled"] = True
    settings.setdefault("markets_page", {})["enabled"] = False
    settings.setdefault("plugins", {})["plugin_secret_code"] = secrets.token_urlsafe(48)
    host = args.explorer_host_file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+", host):
        raise SystemExit(f"invalid explorer hostname in {args.explorer_host_file}")
    # claim challenges are bound to this explorer's own public hostname
    settings.setdefault("claim_address_page", {})["allowed_hosts"] = [host]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + ".new")
    temporary.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o640)
    os.replace(temporary, args.output)


if __name__ == "__main__":
    main()

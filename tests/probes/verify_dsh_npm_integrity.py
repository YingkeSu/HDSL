#!/usr/bin/env python3
"""Generate and verify DSH npm integrity values from the npm registry and real tarballs.

This exists so the sha1/sha512 values recorded in
docs/research/dsh-behavior-probes.md (and in a PR body) are never hand-typed.
Every check is a character-for-character string equality against the exact
registry field and against the sha512 recomputed from the downloaded tarball;
string length is only reported as an auxiliary hint, never used as a substitute
for equality.

Modes:
  --check-doc PATH       extract the per-version rows from PATH and assert equality
  --check-pr-body PATH   extract every sha512 token (and its adjacent shasum)
                         from PATH and assert equality
  --emit-row             print machine-generated markdown rows for the versions
  --write-rows PATH      replace the per-version rows in PATH with generated rows

Usage:
  tests/probes/verify_dsh_npm_integrity.py \
      --check-doc docs/research/dsh-behavior-probes.md \
      --check-pr-body /tmp/pr-body.md
  tests/probes/verify_dsh_npm_integrity.py --emit-row
  tests/probes/verify_dsh_npm_integrity.py --write-rows docs/research/dsh-behavior-probes.md

Exit status: 0 when all checks pass, 1 on any mismatch.
"""
import base64
import hashlib
import json
import re
import sys
import urllib.request

REGISTRY = "https://registry.npmjs.org/@deepseek-ai%2Fdsh"
DEFAULT_VERSIONS = ["0.1.5-rc.2", "0.1.6-alpha.2"]
SHA512_TOKEN = re.compile(r"sha512-[A-Za-z0-9+/=]+")
ROW = re.compile(r"(npm 完整性（`)([^`]+)(`） \| integrity `)[^`]+(`，shasum `)[0-9a-f]+(`)")
PAIR = re.compile(r"`(sha512-[A-Za-z0-9+/=]+)`\s*/\s*`([0-9a-f]{40})`")

failures = 0


def fail(message: str) -> None:
    global failures
    failures += 1
    print(f"  MISMATCH: {message}")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        return response.read()


def tarball_digests(url: str) -> tuple[str, str]:
    blob = fetch(url)
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    return integrity, hashlib.sha1(blob).hexdigest()


def registry_truth(version: str) -> tuple[str, str]:
    """Return the registry integrity/shasum plus the tarball-recomputed values."""
    packument = json.loads(fetch(REGISTRY))
    dist = packument["versions"][version]["dist"]
    tarball_integrity, tarball_shasum = tarball_digests(dist["tarball"])
    if dist["integrity"] != tarball_integrity:
        fail(f"{version}: registry integrity != tarball integrity")
    if dist["shasum"] != tarball_shasum:
        fail(f"{version}: registry shasum != tarball shasum")
    return dist["integrity"], dist["shasum"]


def decoded_length(token: str) -> int:
    payload = token[len("sha512-"):]
    try:
        return len(base64.b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return -1


def char_diff(expected: str, actual: str) -> str:
    if expected == actual:
        return "chars equal"
    for index, (a, b) in enumerate(zip(expected, actual)):
        if a != b:
            return f"first difference at index {index}: expected {a!r}, actual {b!r}"
    return f"prefix equal but length differs: expected {len(expected)}, actual {len(actual)}"


def emit_row(version: str, integrity: str, shasum: str) -> str:
    return (f"| npm 完整性（`{version}`） | integrity `{integrity}`，shasum `{shasum}` "
            f"| 由 [tests/probes/verify_dsh_npm_integrity.py](../../tests/probes/verify_dsh_npm_integrity.py) "
            f"机器生成：registry packument 与实下载 tarball 复算的 `sha1`/`sha512` 逐字符相等，并校验本文记录值 |")


def check_doc(path: str, truth: dict[str, tuple[str, str]]) -> None:
    text = open(path, encoding="utf-8").read()
    for version, (integrity, shasum) in truth.items():
        match = re.search(rf"npm 完整性（`{re.escape(version)}`） \| integrity `([^`]+)`，shasum `([0-9a-f]+)`", text)
        if not match:
            fail(f"doc {version}: row not found")
            continue
        got_integrity, got_shasum = match.group(1), match.group(2)
        ok = got_integrity == integrity and got_shasum == shasum
        print(f"  doc {version}: equal={ok} len={len(got_integrity)} (registry len={len(integrity)}); {char_diff(integrity, got_integrity)}")
        if got_integrity != integrity or got_shasum != shasum:
            fail(f"doc {version}: integrity/shasum != registry")


def check_pr_body(path: str, truth: dict[str, tuple[str, str]]) -> None:
    text = open(path, encoding="utf-8").read()
    expected_integrities = {v[0] for v in truth.values()}
    expected_shasums = {v[1] for v in truth.values()}

    tokens = SHA512_TOKEN.findall(text)
    print(f"  pr-body: {len(tokens)} sha512 token(s); set-equal-to-registry={set(tokens) == expected_integrities}")
    for token in tokens:
        if decoded_length(token) != 64:
            fail(f"pr-body token does not decode to 64 bytes: len={len(token)}")
        if token not in expected_integrities:
            fail(f"pr-body token not in registry set: {char_diff(sorted(expected_integrities)[0], token)}")

    pairs = PAIR.findall(text)
    if pairs:
        got = dict(pairs)
        ok = got == {v[0]: v[1] for v in truth.values()}
        print(f"  pr-body: {len(pairs)} integrity/shasum pair(s); pairs-match-registry={ok}")
        if not ok:
            fail("pr-body integrity/shasum pairs do not match registry")


def main(argv: list[str]) -> int:
    doc = pr_body = write_rows = None
    versions: list[str] = []
    emit = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--check-doc":
            doc = argv[index + 1]; index += 2
        elif arg == "--check-pr-body":
            pr_body = argv[index + 1]; index += 2
        elif arg == "--write-rows":
            write_rows = argv[index + 1]; index += 2
        elif arg == "--emit-row":
            emit = True; index += 1
        else:
            versions.append(arg); index += 1
    versions = versions or DEFAULT_VERSIONS

    truth = {v: registry_truth(v) for v in versions}

    if emit or write_rows:
        rows = [emit_row(v, *truth[v]) for v in versions]
        if emit:
            print("\n".join(rows))
        if write_rows:
            text = open(write_rows, encoding="utf-8").read()
            for v, row in zip(versions, rows):
                pattern = re.compile(rf"\| npm 完整性（`{re.escape(v)}`） \|[^\n]*\|")
                text, count = pattern.subn(lambda _m, row=row: row, text)
                if count != 1:
                    fail(f"{write_rows}: expected exactly one row for {v}, replaced {count}")
            open(write_rows, "w", encoding="utf-8").write(text)
            print(f"  wrote rows for {', '.join(versions)} into {write_rows}")

    if doc:
        print(f"[doc {doc}]")
        check_doc(doc, truth)
    if pr_body:
        print(f"[pr-body {pr_body}]")
        check_pr_body(pr_body, truth)

    print(f"RESULT: {'OK' if failures == 0 else f'{failures} mismatch(es)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

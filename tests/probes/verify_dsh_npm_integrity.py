#!/usr/bin/env python3
"""Verify DSH npm integrity values from the registry and the real tarballs.

Reproducibly regenerates the sha1/sha512 recorded in
docs/research/dsh-behavior-probes.md so those long hashes are never hand-typed.
The registry metadata and the downloaded tarball must agree, and with --doc the
values recorded in the document must agree too.

Usage:
  tests/probes/verify_dsh_npm_integrity.py
  tests/probes/verify_dsh_npm_integrity.py --doc docs/research/dsh-behavior-probes.md
  tests/probes/verify_dsh_npm_integrity.py 0.1.5-rc.2

Exit status: 0 when all values agree, 1 on any mismatch.
"""
import base64
import hashlib
import json
import re
import sys
import urllib.request

REGISTRY = "https://registry.npmjs.org/@deepseek-ai%2Fdsh"
DEFAULT_VERSIONS = ["0.1.5-rc.2", "0.1.6-alpha.2"]


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        return response.read()


def main(argv: list[str]) -> int:
    doc_path = None
    versions = []
    index = 0
    while index < len(argv):
        if argv[index] == "--doc":
            doc_path = argv[index + 1]
            index += 2
        else:
            versions.append(argv[index])
            index += 1
    versions = versions or DEFAULT_VERSIONS

    packument = json.loads(fetch(REGISTRY))
    doc = open(doc_path, encoding="utf-8").read() if doc_path else ""
    failures = 0

    for version in versions:
        dist = packument["versions"][version]["dist"]
        registry_integrity = dist["integrity"]
        registry_shasum = dist["shasum"]
        blob = fetch(dist["tarball"])
        tarball_shasum = hashlib.sha1(blob).hexdigest()
        tarball_integrity = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()

        registry_matches_tarball = (
            registry_integrity == tarball_integrity and registry_shasum == tarball_shasum
        )

        doc_integrity = doc_shasum = None
        if doc:
            match = re.search(
                rf"npm 完整性（`{re.escape(version)}`）.*?integrity `([^`]+)`.*?shasum `([0-9a-f]+)`",
                doc,
            )
            if match:
                doc_integrity, doc_shasum = match.group(1), match.group(2)

        print(f"[{version}]")
        print(f"  registry integrity : {registry_integrity}")
        print(f"  tarball  integrity : {tarball_integrity}")
        print(f"  registry shasum    : {registry_shasum}")
        print(f"  tarball  shasum    : {tarball_shasum}")
        doc_ok = True
        if doc_integrity is not None:
            doc_ok = doc_integrity == registry_integrity and doc_shasum == registry_shasum
            print(f"  doc      integrity : {doc_integrity}  match={doc_integrity == registry_integrity}")
            print(f"  doc      shasum    : {doc_shasum}  match={doc_shasum == registry_shasum}")
        elif doc:
            doc_ok = False
            print("  doc      integrity : <row not found>")

        status = registry_matches_tarball and doc_ok
        print(f"  RESULT: {'OK' if status else 'MISMATCH'}")
        failures += 0 if status else 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

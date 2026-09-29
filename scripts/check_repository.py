#!/usr/bin/env python3
"""Check authored docs and baseline structure without third-party dependencies."""
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    'README.md', 'AGENTS.md', 'CONTEXT.md', 'CONTRIBUTING.md',
    'docs/product/mvp.md', 'docs/product/prd.md', 'docs/product/overview.md',
    'docs/architecture/tdd.md', 'docs/architecture/diagrams.md',
    'docs/README.md', 'docs/development/roadmap.md',
    'docs/development/testing.md', 'docs/development/tooling.md',
    'docs/architecture/principles.md', 'docs/research/dsh-compatibility.md',
    'specs/001-environment-lifecycle/spec.md',
    'specs/001-environment-lifecycle/plan.md',
    'specs/001-environment-lifecycle/tasks.md',
    'specs/001-environment-lifecycle/research.md',
    'specs/001-environment-lifecycle/data-model.md',
    'specs/001-environment-lifecycle/quickstart.md',
    'specs/001-environment-lifecycle/contracts/local-api.md',
    '.github/workflows/repository-checks.yml',
]
errors = []
for name in REQUIRED:
    if not (ROOT / name).is_file() or not (ROOT / name).read_text().strip():
        errors.append(f'Missing or empty: {name}')

# Local tools and notes may remain on disk after being removed from Git.
# Check only publishable files, including new files before they are staged.
repository_files = {
    (ROOT / name).resolve()
    for name in subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        cwd=ROOT,
    ).decode().split('\0') if name
}
authored = sorted(path for path in repository_files
                  if path.suffix == '.md' and path.is_file()
                  and (path.parent == ROOT or path.relative_to(ROOT).parts[0]
                       in {'docs', 'specs', 'tests', 'apps'}))
links = 0
for path in authored:
    content = re.sub(r'```.*?```', '', path.read_text(), flags=re.S)
    for match in re.finditer(r'\[[^\]]*\]\(([^)]+)\)', content):
        target = match.group(1).strip().split(' "')[0].strip('<>')
        if re.match(r'^[a-zA-Z][\w+.-]*:', target) or target.startswith('#'):
            continue
        target = unquote(target.split('#')[0])
        if not target:
            continue
        links += 1
        resolved = (path.parent / target).resolve()
        if (not resolved.is_relative_to(ROOT) or not resolved.exists()
                or (resolved.is_file() and resolved not in repository_files)
                or (resolved.is_dir() and not any(
                    file.is_relative_to(resolved) for file in repository_files))):
            errors.append(f'{path.relative_to(ROOT)}: invalid local link {target}')

json_count = 0
for base in (ROOT / 'specs', ROOT / 'packages/runtime/catalog'):
    for path in base.rglob('*.json'):
        try:
            json.loads(path.read_text())
            json_count += 1
        except (ValueError, OSError) as exc:
            errors.append(f'{path.relative_to(ROOT)}: {exc}')

# Requirement / task id integrity (issue #15 residual).
#
# The previous revision hardcoded a fixed `range(1, 9)`: once the 001 slice
# added FR-009+/T009+ the check silently stopped verifying them, i.e. it went
# stale rather than failing. This revision derives the declared ids from the
# documents (spec-driven range) and verifies them against the frozen baseline
# contract below. Adding new contiguous ids needs no edit here; dropping,
# renumbering or duplicating a frozen id fails.
FROZEN_FR_IDS = tuple(range(1, 9))  # FR-001..FR-008, frozen by T003 (see #15)
FROZEN_TASK_IDS = tuple(range(1, 9))  # T001..T008; T008a/T008b are sub-slices

FR_DEFINITION = re.compile(r'^\s*-\s*\*\*(FR-\d{3})\*\*:', re.M)
TASK_DEFINITION = re.compile(r'^\s*-\s*\[[ xX]\]\s*(T\d{3}(?:\.\d+)?[a-z]?)', re.M)


def _marker(prefix, number):
    return f'{prefix}-{number:03d}' if prefix == 'FR' else f'T{number:03d}'


def _id_number(token):
    if token.startswith('FR-'):
        return int(token[3:])
    match = re.match(r'T(\d{3})', token)
    return int(match.group(1)) if match else None


def _collect_definitions(pattern, text, label):
    tokens = pattern.findall(text)
    if not tokens:
        errors.append(f'Missing {label}: the document defines no {label} ids')
    for token in sorted(set(tokens)):
        if tokens.count(token) > 1:
            errors.append(f'Duplicate {label} definition: {token}')
    return tokens


def _verify_id_contract(label, prefix, tokens, frozen):
    numbers = {number for number in (_id_number(token) for token in tokens) if number is not None}
    # Spec-driven range: numbering must stay contiguous from FR-001/T001 so an
    # accidental renumber that leaves a gap is reported.
    for number in range(1, (max(numbers) + 1) if numbers else 1):
        if number not in numbers:
            errors.append(f'Missing {label}: {_marker(prefix, number)}')
    # Explicit frozen contract: an id that existed at the T003 freeze must not
    # disappear even when the numbering above is compressed without a gap.
    for number in frozen:
        if number not in numbers:
            errors.append(f'Missing {label}: {_marker(prefix, number)}')


spec_path = ROOT / 'specs/001-environment-lifecycle/spec.md'
tasks_path = ROOT / 'specs/001-environment-lifecycle/tasks.md'
if spec_path.is_file() and tasks_path.is_file():
    fr_tokens = _collect_definitions(FR_DEFINITION, spec_path.read_text(), 'requirement')
    task_tokens = _collect_definitions(TASK_DEFINITION, tasks_path.read_text(), 'task')
    _verify_id_contract('requirement', 'FR', fr_tokens, FROZEN_FR_IDS)
    _verify_id_contract('task', 'T', task_tokens, FROZEN_TASK_IDS)
    requirement_count = len({_id_number(token) for token in fr_tokens})
    task_count = len({_id_number(token) for token in task_tokens})
else:
    requirement_count = 0
    task_count = 0
    errors.append('Cannot verify requirement/task ids: spec.md or tasks.md is missing')

if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'PASS: {len(REQUIRED)} required files, {len(authored)} authored docs, {links} local links, {json_count} JSON files, {requirement_count} requirements and {task_count} tasks.')
print('Scope: repository integrity only; no DSH runtime or desktop acceptance tests.')

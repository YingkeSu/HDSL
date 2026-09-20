#!/usr/bin/env python3
"""Check authored docs and baseline structure without third-party dependencies."""
import json
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    'README.md', 'AGENTS.md', 'CONTEXT.md', 'CONTRIBUTING.md',
    'docs/product/mvp.md', 'docs/product/prd.md', 'docs/product/overview.md',
    'docs/architecture/tdd.md', 'docs/architecture/diagrams.md',
    'docs/research/provenance.md', 'docs/development/roadmap.md',
    'docs/development/testing.md', 'docs/agents/issue-tracker.md',
    'docs/agents/triage-labels.md', 'docs/agents/domain.md',
    '.specify/memory/constitution.md', '.specify/LICENSE',
    '.specify/integration.json', '.agents/skills/speckit-specify/SKILL.md',
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

# Generated upstream templates intentionally contain example links/placeholders.
# Check authored documentation, not those template examples.
authored = list(ROOT.glob('*.md')) + list((ROOT / 'docs').rglob('*.md')) + list((ROOT / 'specs').rglob('*.md'))
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
        if not resolved.is_relative_to(ROOT) or not resolved.exists():
            errors.append(f'{path.relative_to(ROOT)}: invalid local link {target}')

json_count = 0
for base in (ROOT / '.specify', ROOT / 'specs'):
    for path in base.rglob('*.json'):
        try:
            json.loads(path.read_text())
            json_count += 1
        except (ValueError, OSError) as exc:
            errors.append(f'{path.relative_to(ROOT)}: {exc}')

spec = (ROOT / 'specs/001-environment-lifecycle/spec.md').read_text()
tasks = (ROOT / 'specs/001-environment-lifecycle/tasks.md').read_text()
for prefix, content in [('FR', spec), ('T', tasks)]:
    for number in range(1, 9):
        marker = f'{prefix}-{number:03}' if prefix == 'FR' else f'T{number:03}'
        if marker not in content:
            errors.append(f'Missing requirement/task: {marker}')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'PASS: {len(REQUIRED)} required files, {len(authored)} authored docs, {links} local links, {json_count} JSON files, 8 requirements and 8 tasks.')
print('Scope: repository integrity only; no DSH runtime or desktop acceptance tests.')

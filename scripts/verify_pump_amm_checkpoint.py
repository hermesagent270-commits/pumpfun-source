#!/usr/bin/env python3
"""Verify the selected AMM source recipe, saved proof, or its exact fresh replay."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT = 'repro/pump_amm/optional-context-recovery-20261027'
ARTIFACT = CHECKPOINT + '/results/build/candidate.so'
CANDIDATE = '97bd5553c199cd24fb2d07034c365527bee5b138bf5dd7a0aa3099186aad2643'
MANIFEST = 'a00fa646e610ece0a0ea7f9d202bc7e6526d5a2e310d3881703f7d3c4a7d5cde'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify(root=ROOT, runtime=None):
    root = Path(root).resolve()
    selected = json.loads((root / 'repro/status.json').read_text())['pump_amm']
    assert selected['candidate_artifact'] == ARTIFACT
    assert selected['candidate_sha256'] == CANDIDATE
    checkpoint = root / CHECKPOINT
    results = checkpoint / 'results'
    candidate = root / ARTIFACT
    assert sha(candidate) == CANDIDATE and sha(results / 'manifest.json') == MANIFEST
    if runtime is None:
        # Capture only stdout: the saved verifier's stderr (its failing
        # assertion) must stay visible in the caller's log.
        result = subprocess.run(
            [sys.executable, '-B', str(checkpoint / 'verify_saved.py'), '--current-source'],
            cwd=root, text=True, stdout=subprocess.PIPE, check=True,
        )
        report = json.loads(result.stdout.strip().splitlines()[-1])
        assert report['current_source_checked'] and report['candidate_sha256'] == CANDIDATE
        return {'status': 'PASS', 'program': 'pump_amm', **report}
    entries = json.loads((results / 'manifest.json').read_text())
    assert set(entries) | {'manifest.json'} == {
        str(path.relative_to(results)) for path in results.rglob('*') if path.is_file()
    }
    for name, digest in entries.items():
        assert sha(results / name) == digest, name
    for name in ['verify_source_binding.py', 'workspace_recipe_v2.py']:
        assert sha(checkpoint / name) == sha(results / 'harness' / name)
    sys.path.insert(0, str(checkpoint))
    try:
        binding = module('selected_amm_source', checkpoint / 'verify_source_binding.py')
        bound = binding.verify(results / 'canonical-source', results / 'source',
                               results / 'build/build-comparison.json', candidate,
                               results / 'build/unstripped.so', results / 'dependency-proof', root)
    finally:
        sys.path.pop(0)
    assert bound['total_compiled_inputs_verified'] == 227 and bound['current_source_verified']
    dependencies = module('selected_amm_dependencies', results / 'dependency-proof/verify.py')
    assert dependencies.verify(results / 'canonical-source', results / 'build/build-comparison.json')['packages'] == 9
    runtime = Path(runtime).resolve()
    inputs = json.loads((runtime / 'inputs.json').read_text())
    assert inputs['candidate_sha256'] == CANDIDATE
    for name, digest in inputs['harness_sha256'].items():
        assert sha(root / name) == digest, name
    assert inputs['observer_sha256'] == sha(root / 'repro/pump_amm/owner6048-v144/runtime/observe_suite.py')
    audit = module('selected_amm_audit', checkpoint / 'compare_direct_cached.py')
    report = audit.audit(runtime, CANDIDATE)
    assert report['cases'] == 17462 and not report['mismatches']
    return {'status': 'PASS', 'program': 'pump_amm', 'candidate_sha256': CANDIDATE, **report}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--runtime', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.repo, args.runtime), indent=2))

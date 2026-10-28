# PumpSwap optional-u64 and Context recovery

Candidate `97bd5553c199cd24fb2d07034c365527bee5b138bf5dd7a0aa3099186aad2643` matches **651/785 normalized original windows
(82.9%)**, including **148 raw-equal bodies**, and **816,800/1,162,040 text bytes
(70.3%)**. It adds four normalized matches with no normalized or raw losses.
**134 windows remain; whole ELF identity is false.** These are bounded binary
recovery measurements, not an estimate of completed engineering work.

The OptionalU64 decoder now uses the observed non-consuming short-read fallback
for the actual Borsh slice reader. Its 3,064-byte CreatePool dispatch wrapper
matches. All 123 differences in the prior264-case signed short-tail matrix are
closed: following optional booleans see the same bytes as in the original.
The original failures, successful transactions and source/reader limitations
remain in the linked [prior checkpoint](../event-decoder-recovery-20261027/README.md).
No claim is made about arbitrary custom implementations of std::io::Read.

The three V2 trade dispatch wrappers now match at1,064 bytes each. Handler source
uses its evidenced instructions/swap/trade_v2.rs module and public entry
boundaries, preserving the original40-byte Context ABI. Internal quote helpers
retain their prior visibility so their scalar calling convention and preview
body remain matched. The V2 business handlers themselves are still unmatched.

Creator payout follows typed context fields, reconstructs signer seeds per CPI,
and propagates final CPI failures before returning Ok, matching the observed
call boundaries. Focused tests and actual target/trace checks pass; complete
payout-handler byte identity remains unproved.

Two strict offline builds agree. The recipe binds **51 canonical inputs**,
**52 workspace inputs**, **175 registry inputs**, **227 total**, across nine
authenticated dependency roots. **762 cached dependency artifacts remain
unchanged**. Complete original lockfile/toolchain provenance remains unresolved.

All **17,462 core cases**, **35,074 executions**, **35,418 signature fields** and
**17,537 identical signed-message pairs** pass. Retained supplemental suites and
focused decoder, creator, V2, ATA, resize, entrypoint and state controls are rerun
on this exact candidate. Counts overlap; packets list their individual scope,
fixture dependencies, normalized fields and cryptographic checks.

Full code, data, calls, relocations, provenance, exhaustive behavior and authentic
fixed-admin create_config success remain open. See the
[remaining-window partition](remaining-work.json).

```sh
python -B repro/pump_amm/optional-context-recovery-20261027/verify_saved.py
```

Use `--current-source` to bind maintained AMM files. Result manifest:
`a00fa646e610ece0a0ea7f9d202bc7e6526d5a2e310d3881703f7d3c4a7d5cde`.

[Additional evidence and next-step research](followup/README.md) is separately sealed.

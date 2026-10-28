#!/usr/bin/env python3
"""Validate the integrated AMM checkpoint from saved code and signed observations."""
from pathlib import Path
import argparse,base64,gzip,hashlib,importlib.util,json,subprocess,sys,tempfile
from solders.transaction import Transaction
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
ORIGINAL='6a7ad34596d83b4c435b32f458a56e718e9f82eb4ad38e4316616d15d24d8ff7'
CANDIDATE='97bd5553c199cd24fb2d07034c365527bee5b138bf5dd7a0aa3099186aad2643'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):
 p=Path(p)
 if not p.exists()and p.suffix=='.json':p=p.with_suffix('.json.gz')
 b=p.read_bytes();return json.loads(gzip.decompress(b)if p.suffix=='.gz'else b)
def module(n,p):
 s=importlib.util.spec_from_file_location(n,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def main():
 p=argparse.ArgumentParser();p.add_argument('--current-source',action='store_true');a=p.parse_args();d=HERE/'results';candidate=d/'build/candidate.so'
 assert sha(d/'manifest.json')==MANIFEST;entries=load(d/'manifest.json')
 assert set(entries)|{'manifest.json'}=={str(f.relative_to(d))for f in d.rglob('*')if f.is_file()}
 for name,digest in entries.items():assert sha(d/name)==digest
 record=load(d/'build/build-comparison.json');assert sha(candidate)==record['comparison']['candidate_sha256']==CANDIDATE
 assert record['returncode']==0 and record['source_unchanged'] and record['source_sha256']==record['source_after_sha256']
 assert record['dependency_cache_before']==record['dependency_cache_after'] and record['dependency_cache_before']
 assert record['unstripped_sha256']==sha(d/'build/unstripped.so') and record['build_log_sha256']==sha(d/'build/build.log')
 assert len(record['source_sha256'])==227
 assert not record['priming'] and record['command'][-2:]==['--locked','--offline']
 assert record['command'][record['command'].index('--target')+1]=='sbpf-solana-solana' and '--manifest-path' in record['command']
 assert record['environment']['CARGO_TARGET_SBPF_SOLANA_SOLANA_RUSTFLAGS']==' -Zremap-cwd-prefix='
 assert sha(d/'build-driver.py')==record['adapter_sha256']
 assert sha(d/'target-provenance.json')==record['target_provenance_sha256']
 assert sha(d/'sbpf-archive-provenance.json')==record['sbpf_archive_provenance_sha256']
 repeat=load(d/'build-repeat.json');assert repeat['comparison']['candidate_sha256']==CANDIDATE and repeat['unstripped_sha256']==record['unstripped_sha256']
 assert repeat['source_sha256']==record['source_sha256'] and repeat['dependency_cache_before']==repeat['dependency_cache_after']==record['dependency_cache_after']
 assert sha(d/'build-repeat.log')==repeat['build_log_sha256'] and repeat['returncode']==0 and repeat['source_unchanged']
 assert repeat['source_after_sha256']==record['source_sha256'] and not repeat['priming']
 for name in ['verify_source_binding.py','workspace_recipe_v2.py']:
  assert sha(HERE/name)==sha(d/'harness'/name)
 source_binding=module('portable_source_binding',HERE/'verify_source_binding.py').verify(d/'canonical-source',d/'source',d/'build/build-comparison.json',candidate,d/'build/unstripped.so',d/'dependency-proof',ROOT if a.current_source else None)
 assert source_binding['total_compiled_inputs_verified']==227 and source_binding['standalone_inputs']==51
 dependency=module('liquidity_dependencies',d/'dependency-proof/verify.py').verify(d/'canonical-source',d/'build/build-comparison.json')
 assert dependency['total_build_inputs_bound']==227 and dependency['packages']==9
 assert sha(HERE/'compare_direct_cached.py')==sha(d/'harness/compare_direct_cached.py')
 direct=module('order_direct',HERE/'compare_direct_cached.py')
 corpus=direct.audit(d/'runtime',CANDIDATE);assert corpus==load(HERE/'direct-comparison.json')and not corpus['mismatches']
 assert(corpus['cases'],corpus['transactions'],corpus['signature_fields'])==(17462,35074,35418)
 inputs=load(d/'runtime/inputs.json');assert inputs['original_sha256']==ORIGINAL and inputs['candidate_sha256']==CANDIDATE
 for name,digest in inputs['harness_sha256'].items():assert sha(d/'harness'/Path(name).name)==digest
 assert inputs['observer_sha256']==sha(d/'harness/observe_suite.py')
 assert inputs['replay_driver_sha256']==sha(d/'harness/replay_parallel.py')==sha(HERE/'replay_parallel.py') and inputs['workers']==8 and inputs['ordering']=='descending-case-count'
 buy=load(d/'buyback.json');assert buy['candidate_sha256']==CANDIDATE and len(buy['cases'])==72
 for c in buy['cases']:
  assert not c['diff']and direct.clean(c['original'])==direct.clean(c['candidate'])
  for side in ['original','candidate']:assert all(Transaction.from_bytes(base64.b64decode(c[side]['transaction_base64'])).verify_with_results())
 assert module('order_cpi',ROOT/'repro/pump_amm/diagnostic-parity-20261027/verify_cpi.py').verify(d,candidate)==91
 agent=ROOT/'repro/pump_amm/fee-account-decoder-agent-20261027';ad=d/'account-probes'
 module('order_fees',agent/'verify_probe.py').verify(ad/'fee.json.gz',ad/'fee-transactions.json.gz',candidate)
 ev=module('order_extra',agent/'verify_extra.py')
 for kind in ['v2','multi']:ev.verify(kind,ad/(kind+'.json.gz'),ad/(kind+'-transactions.json.gz'),candidate)
 wv=module('order_whitelist',agent/'verify_whitelist.py')
 for kind,name in [('basic','whitelist'),('order','whitelist-order')]:wv.verify(kind,ad/(name+'.json.gz'),ad/(name+'-transactions.json.gz'),candidate)
 subprocess.run([sys.executable,'-B',str(ROOT/'repro/pump_amm/trade-helpers-agent-20261027/verify_fee_order_receipts.py'),str(d/'trade-probes'),'--candidate',str(candidate),'--require-parity'],check=True,stdout=subprocess.DEVNULL)
 extra=load(d/'liquidity-extra.json');sidecar=load(d/'liquidity-extra-transactions.json.gz');assert len(extra['cases'])==18 and len(sidecar['transactions'])==36
 for i,c in enumerate(extra['cases']):
  assert direct.clean(c['original'])==direct.clean(c['candidate']) and not c['differences']
  pair=sidecar['transactions'][i*2:i*2+2];messages=[]
  for label,t,digest in zip(['original','candidate'],pair,[ORIGINAL,CANDIDATE]):
   raw=base64.b64decode(t['transaction_base64'],validate=True);tx=Transaction.from_bytes(raw);assert all(tx.verify_with_results())and t['all_signatures_verified'];assert hashlib.sha256(raw).hexdigest()==t['transaction_sha256']
   assert t['amm_program_sha256']==digest and t['logs_sha256']==hashlib.sha256(json.dumps(c[label]['logs'],separators=(',',':')).encode()).hexdigest();messages.append(bytes(tx.message))
  assert messages[0]==messages[1]
 v2=module('v2_boundaries',ROOT/'repro/pump_amm/v2-fee-boundaries-20261027/verify.py')
 for name,producer,count in [('boundary','probe.py',72),('transfer','probe_transfer.py',4),('validation-order','probe_validation_order.py',252),('curve-order','probe_curve_order.py',32),('legacy-curve-order','probe_legacy_curve_order.py',32),('matrix','../curve-arithmetic-recovery-20261027/probe_matrix.py',1536),('market-cap','../fee-selection-recovery-20261027/probe_market_cap_order.py',48),('quote-routes','../fee-selection-recovery-20261027/probe_quote_routes.py',20)]:
  v2.verify(d/'v2-probes'/(name+'.json.gz'),d/'v2-probes'/(name+'-transactions.json.gz'),candidate,producer,count,0)
 nd=ROOT/'repro/pump_amm/result-context-recovery-20261027/negative';assert sha(nd/'manifest.json')=='f42fc10ff3713eb51eb6e4bf6f8c88816e02030eb5a3eaf9c80fa78a52e40dba'
 for name,digest in load(nd/'manifest.json').items():assert sha(nd/name)==digest
 previous=ROOT/'repro/pump_amm/fee-selection-recovery-20261027/results/build/candidate.so'
 v2.verify(nd/'quote-routes.json.gz',nd/'quote-routes-transactions.json.gz',previous,'../fee-selection-recovery-20261027/probe_quote_routes.py',20,1)
 symbols=d/'build/unstripped.so'
 helpers=module('fee_helpers',HERE/'inspect_helpers.py').inspect(candidate,symbols)
 assert helpers==load(d/'helper-comparison.json')
 for target in [0x14700,0x4fba0,0xdade8,0x727b8,0xd5848,0xd69a0,0x73118,0x72128,0x716b8,0x70280,0x565e8]:assert any(p['normalized_exact'] for row in helpers['rows'] if row['original_start']==target for p in row['candidates'])
 for name,path in [('pool','pool-layouts-agent-20261027'),('global','global-config-layouts-agent-20261027')]:
  result=module('order_'+name,ROOT/'repro/pump_amm'/path/'verify_static.py').verify(candidate,symbols);assert result==load(HERE/(name+'-static.json'))
 assert module('order_liquidity',ROOT/'repro/pump_amm/liquidity-account-audit-agent-20261027/audit.py').audit(candidate,symbols)==load(HERE/'liquidity-static.json')

 sqrt=module('sqrt_proof',ROOT/'repro/pump_amm/create-sqrt-recovery-20261027/verify_sqrt.py')
 assert sqrt.verify(d/'sqrt.json.gz',d/'sqrt-transactions.json.gz',candidate)=={'cases':40,'successful_original_supply_checks':33,'mismatches':0}
 assert sqrt.verify(d/'sqrt-negative/sqrt.json.gz',d/'sqrt-negative/sqrt-transactions.json.gz',d/'sqrt-negative/candidate.so',3)=={'cases':40,'successful_original_supply_checks':33,'mismatches':3}
 dependencies=load(d/'dependency-provenance.json')
 assert set(dependencies)=={'uint','hex','static_assertions'}
 for row in dependencies.values():assert sha(d/'dependencies'/row['crate_file'])==row['archive_sha256']==row['cached_registry_checksum']
 closure=module('sqrt_closure',ROOT/'repro/pump_amm/call-closure-audit-20261027/audit.py').analyze(candidate,symbols,d/'measurement.json.gz')
 assert closure==load(d/'call-closure.json')
 literals=module('sqrt_literals',ROOT/'repro/pump_amm/call-closure-audit-20261027/literal_constraints.py').analyze(candidate,symbols,closure)
 assert literals==load(d/'literal-constraints.json') and not literals['counts']['unequal_literal_uses']

 extra=module('parallel_supplemental',HERE/'verify_supplemental.py')
 for name,producer,count in [('order','probe_order.py',8),('buyback-payout','probe_buyback.py',14),('buyback-malformed','probe_buyback_malformed.py',16),('preview','probe_preview.py',36),('token-preview','probe_token_preview.py',24)]:
  assert sha(d/'supplemental'/producer)==sha(HERE/producer)
  assert extra.verify(d/'supplemental'/(name+'.json.gz'),d/'supplemental'/(name+'-transactions.json.gz'),candidate,HERE/producer,count)=={'cases':count,'mismatches':0}
 preview_bad=15
 assert sha(d/'failure-baselines/preview-candidate.so')=='b4578a32eb691945ad6c89f30121582f854d64a6d5946f1048c66043fa6b9085'
 assert extra.verify(d/'failure-baselines/preview.json.gz',d/'failure-baselines/preview-transactions.json.gz',d/'failure-baselines/preview-candidate.so',HERE/'probe_preview.py',36,preview_bad)=={'cases':36,'mismatches':preview_bad}
 baseline=d/'failure-baselines/candidate.so'
 assert sha(baseline)=='6f5050382173bd166e5370594ddc1c67a4b1ce9ddec631656cee41371bc0425b'
 assert extra.verify(d/'failure-baselines/token-preview.json.gz',d/'failure-baselines/token-preview-transactions.json.gz',baseline,HERE/'probe_token_preview.py',24,4)=={'cases':24,'mismatches':4}
 assert extra.verify(d/'failure-baselines/order.json.gz',d/'failure-baselines/order-transactions.json.gz',baseline,HERE/'probe_order.py',8,4)=={'cases':8,'mismatches':4}
 canonical=module('parallel_canonical',HERE/'verify_canonical_mint.py')
 assert canonical.verify(d/'supplemental/canonical-mint.json.gz',candidate,d/'build/build-comparison.json')=={'cases':12,'signed_transactions':24,'mismatches':0}
 policy=module('parallel_policy',HERE/'verify_mint_policy.py')
 assert policy.verify(d/'supplemental/mint-policy.json.gz',candidate,d/'build/build-comparison.json')=={'cases':46,'signed_transactions':92,'mismatches':0}
 assert policy.verify(d/'failure-baselines/mint-policy.json.gz',baseline,d/'failure-baselines/build-comparison.json',15)=={'cases':46,'signed_transactions':92,'mismatches':15}
 raw=module('parallel_raw',HERE/'verify_raw_payout.py')
 assert raw.verify(d/'supplemental/raw.json.gz',candidate,d/'build/build-comparison.json')=={'cases':36,'signed_transactions':72,'mismatches':0}
 assert raw.verify(d/'failure-baselines/raw.json.gz',baseline,d/'failure-baselines/build-comparison.json',1)=={'cases':36,'signed_transactions':72,'mismatches':1}
 context=module('new_context_proof',HERE/'verify_contexts.py')
 assert context.verify(d/'supplemental/contexts.json.gz',d/'supplemental/contexts-transactions.json.gz',candidate)=={'cases':21,'signed_transactions':42,'mismatches':0}
 assert context.verify(d/'failure-baselines/contexts.json.gz',d/'failure-baselines/contexts-transactions.json.gz',d/'failure-baselines/contexts-candidate.so',18)=={'cases':21,'signed_transactions':42,'mismatches':18}
 for name,producer,count,bad in [('multihop-bumps','probe_multihop_bumps.py',24,8),('sell-cap','probe_sell_cap.py',8,4),('sell-transfers','probe_sell_transfers.py',12,2)]:
  assert sha(d/'supplemental'/producer)==sha(HERE/producer)
  if name=='multihop-bumps':
   assert context.verify(d/'supplemental'/(name+'.json.gz'),d/'supplemental'/(name+'-transactions.json.gz'),candidate,count=count,producer=HERE/producer)['mismatches']==0
   assert context.verify(d/'failure-baselines'/(name+'.json.gz'),d/'failure-baselines'/(name+'-transactions.json.gz'),d/'failure-baselines/new-candidate.so',bad,count, HERE/producer)['mismatches']==bad
  else:
   assert extra.verify(d/'supplemental'/(name+'.json.gz'),d/'supplemental'/(name+'-transactions.json.gz'),candidate,HERE/producer,count)['mismatches']==0
   assert extra.verify(d/'failure-baselines'/(name+'.json.gz'),d/'failure-baselines'/(name+'-transactions.json.gz'),d/'failure-baselines/new-candidate.so',HERE/producer,count,bad)['mismatches']==bad
 delta=load(d/'old-to-new.json');assert delta['gained']==[930208, 953064, 954128, 955192] and delta['lost']==[]
 assert delta['matched_text_bytes']==816800 and delta['original_text_bytes']==1162040
 assert sha(d/'route-baselines/candidate.so')=='ac96a53eb7fa3f24ca275ceca733b99e4a4ced20460ee41d6979d683042be797'
 assert sha(HERE/'verify_routes.py')==sha(d/'harness/verify_routes.py')
 route=module('new_route_proof',HERE/'verify_routes.py')
 for name,producer,count,bad in [('multihop-edges','probe_multihop_edges.py',350,116),('multihop-large','probe_multihop_large.py',72,0),('multihop-routes','probe_multihop_routes.py',32,12),('pool-decoders','probe_pool_decoders.py',46,0)]:
  assert sha(d/'supplemental'/producer)==sha(HERE/producer)
  for location,binary,expected in [('routes',candidate,0),('route-baselines',d/'route-baselines/candidate.so',bad)]:
   own=d/location/'pool-decoders-snapshots.json.gz'if name=='pool-decoders'else None
   assert route.verify(d/location/(name+'.json.gz'),d/location/(name+'-signed-observer.json.gz'),binary,HERE/producer,count,expected,own)['mismatches']==expected
 assert extra.verify(d/'routes/buy-events.json.gz',d/'routes/buy-events-signed-observer.json.gz',candidate,HERE/'probe_buy_events.py',16)['mismatches']==0
 for location,binary,expected in [('routes',candidate,0),('route-baselines',d/'route-baselines/candidate.so',1)]:
  assert extra.verify(d/location/'buy-executors.json.gz',d/location/'buy-executors-signed-observer.json.gz',binary,HERE/'probe_buy_executors.py',18,expected)['mismatches']==expected
 assert sha(HERE/'verify_error_order.py')==sha(d/'harness/verify_error_order.py')
 integration=load(d/'integration-inputs.json')
 assert integration['base_candidate_sha256']==sha(d/'error-order-baselines/candidate.so')
 for path,digest in integration['patches'].items():assert sha(d/'integration-patches'/Path(path).name)==digest
 error_order=module('new_error_order_proof',HERE/'verify_error_order.py').verify(d,candidate)
 assert error_order=={'cases':1485,'baseline_mismatches':67,'candidate_mismatches':0,'signatures':5940}
 assert sha(HERE/'verify_pool_abi.py')==sha(d/'harness/verify_pool_abi.py')
 pool_abi=module('pool_abi_current',HERE/'verify_pool_abi.py').verify(candidate,symbols,ROOT)
 assert pool_abi==load(d/'pool-abi.json')
 negative=d/'new-integration/deposit-baseline'
 assert sha(negative/'candidate.so')=='8e69bb1b3d95dab5fb398f7842efbb9d2234075ec206fa447060bdd92714f328'
 original_deposit=load(negative/'baseline-probe.json');current_deposit=load(d/'liquidity-probes/deposit-44.json')
 assert original_deposit['candidate_sha256']==sha(negative/'candidate.so') and original_deposit['original_sha256']==ORIGINAL
 assert original_deposit['probe_sha256']==sha(negative/'probe.py')==sha(d/'new-integration/producers/deposit-44.py')
 assert original_deposit['case_count']==current_deposit['case_count']==44
 baseline_tx=load(negative/'baseline-transactions.json.gz')['transactions'];current_tx=load(d/'liquidity-probes/deposit-44-transactions.json.gz')['transactions'];assert len(baseline_tx)==len(current_tx)==88
 bad=0
 for i,row in enumerate(original_deposit['cases']):
  bad+=direct.clean(row['original'])!=direct.clean(row['candidate'])
  assert row['case']==current_deposit['cases'][i]['case'] and direct.clean(row['original'])==direct.clean(current_deposit['cases'][i]['original'])
  for j,label in enumerate(['original','candidate']):
   evidence=baseline_tx[i*2+j];tx=Transaction.from_bytes(base64.b64decode(evidence['transaction_base64'],validate=True));assert all(tx.verify_with_results()) and evidence['all_signatures_verified']
   assert bytes(tx.message)==bytes(Transaction.from_bytes(base64.b64decode(current_tx[i*2+j]['transaction_base64'],validate=True)).message)
   assert evidence['amm_program_sha256']==(ORIGINAL if j==0 else sha(negative/'candidate.so'))
   assert evidence['logs_sha256']==hashlib.sha256(json.dumps(row[label]['logs'],separators=(',',':')).encode()).hexdigest()
 assert bad==original_deposit['mismatch_count']==4
 with tempfile.TemporaryDirectory()as tmp:
  out=Path(tmp)/'measurement.json';subprocess.run([sys.executable,'-B',str(ROOT/'repro/pump_amm/focused-diagnostics-20261026/measure.py'),'--candidate',str(candidate),'--symbols',str(symbols),'--output',str(out)],check=True,stdout=subprocess.DEVNULL);assert load(out)==load(d/'measurement.json');assert (load(out)['normalized_matches'],load(out)['raw_matches'])==(651,148)
 liquidity_module=module('liquidity_new_evidence',HERE/'verify_liquidity.py')
 for name,digest in liquidity_module.PRODUCERS.items():assert sha(d/'new-integration/producers'/(name+'.py'))==digest
 liquidity=liquidity_module.verify(d,candidate,symbols)
 assert liquidity['cases']==1350 and liquidity['passed'] is True
 refinements=module('liquidity_refinements',HERE/'verify_refinements.py').verify(d,candidate,direct.clean)
 assert refinements=={'cases':76,'signatures':152,'mismatches':0}
 assert sha(d/'tlv-proof/manifest.json')=='bc97cbf9d77694c369186320de064214a71a189fac58f77f005d8bb4a8d1aeaa'
 subprocess.run([sys.executable,'-B',str(d/'tlv-proof/verify_bundle.py'),'--expected-seal','bc97cbf9d77694c369186320de064214a71a189fac58f77f005d8bb4a8d1aeaa'],cwd=d/'tlv-proof',check=True,stdout=subprocess.DEVNULL)
 assert sha(d/'decoder-proof/manifest.json')=='8fded8e3d4bffdde2110fe6dbae3d16183bd183cb13d01acbd0352856dcbaf94'
 subprocess.run([sys.executable,'-B',str(d/'decoder-proof/verify_packet.py')],cwd=d/'decoder-proof',check=True,stdout=subprocess.DEVNULL)
 assert sha(HERE/'verify_new_proofs.py')==sha(d/'harness/verify_new_proofs.py')
 current_expanded=module('current_expanded_proofs',HERE/'verify_new_proofs.py').verify(d,candidate,ROOT)
 assert sha(HERE/'verify_recovery.py')==sha(d/'harness/verify_recovery.py')
 recovery=module('current_recovery',HERE/'verify_recovery.py').verify(d,candidate,ROOT)
 print(json.dumps({**corpus,**current_expanded,**recovery,'candidate_sha256':CANDIDATE,'buyback_cases':72,'cpi_cases':91,'account_fee_cases':1281,'trade_fee_cases':273,'liquidity_cases':18,'trade_boundary_cases':1996,'sqrt_cases':40,'new_transfer_order_cases':134,'mint_policy_cases':58,'context_constraint_cases':21,'normalized_matches':651,'raw_matches':148,'new_route_decoder_event_cases':534,'new_multihop_sell_cases':44,'error_order_cases':1485,'error_order_baseline_mismatches':67,'error_order_signature_fields':5940,'new_liquidity_cases':liquidity['cases'],'new_pool_predicate_cases':refinements['cases'],'dependency_packages':dependency['packages'],'build_source_inputs':227,'canonical_source_inputs':51,'transfer_fee_decoder_cases':58,'transfer_fee_decoder_baseline_mismatches':20,'independent_tlv_cases':876,'independent_tlv_baseline_mismatches':430,'current_source_checked':a.current_source,'whole_elf_equal':False}))
MANIFEST='a00fa646e610ece0a0ea7f9d202bc7e6526d5a2e310d3881703f7d3c4a7d5cde'
if __name__=='__main__':main()

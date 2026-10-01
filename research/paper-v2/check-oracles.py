"""要求からの参照式と独立したJSON契約検査。生成candidate/fixtureは読まない。"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent

def load(name):
    return json.loads((ROOT / name).read_text())

def valid(contract, data):
    fields = contract['fields']
    if set(data) - {f['name'] for f in fields}:
        return False
    for f in fields:
        if f['name'] not in data:
            if not f['optional']:
                return False
            continue
        v = data[f['name']]
        if v is None:
            if not f['nullable']:
                return False
        elif f['kind'] == 'boolean':
            if type(v) is not bool:
                return False
        elif type(v) is not str or (f['kind'] == 'enum' and v not in f['values']):
            return False
    return True

rules = {
    'logic': lambda x: x['a'] and (x['b'] or not x['c']),
    'contact': lambda x: x.get('email') is not None and x['tier'] == 'premium',
    'boundary': lambda x: x['level'] == 'high',
    'unsupported': lambda x: x['email'].endswith('@example.com'),
}
for task, rule in rules.items():
    source = load(f'{task}-source.json')
    oracle = load(f'{task}-oracle-draft.json')
    for case in oracle['cases']:
        actual = ({'kind': 'value', 'value': rule(case['input'])}
                  if valid(source['contract'], case['input'])
                  else {'kind': 'error', 'code': 'INVALID_INPUT'})
        assert actual == case['expected'], (task, case['id'], actual)
    print(f"{task}: {len(oracle['cases'])} expectations matched")
# 旧Oracleが見逃す誤式に対して、修正Oracleに反例があることを確認する。
mutants = {
    'logic': lambda x: x['a'] and (x['b'] == x['c']),
    'contact': lambda x: bool(x.get('email')) and x['tier'] == 'premium',
}
for task, mutant in mutants.items():
    witnesses = [c['id'] for c in load(f'{task}-oracle-draft.json')['cases']
                 if c['expected']['kind'] == 'value' and mutant(c['input']) != c['expected']['value']]
    assert witnesses, task
    print(f'{task}: wrong rule rejected by {witnesses}')

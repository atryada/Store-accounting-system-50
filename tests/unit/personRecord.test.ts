import { describe, expect, test } from 'vitest';
import { preparePersonRecord } from '../../src/db/person-record';

describe('person records', () => {
  test('creates a person, detailed account and child contacts together', () => {
    const { person, changes } = preparePersonRecord({}, {id:'p', name:'  آزمون  ', contacts:[{number:'123'}], initialBalance:10, initialBalanceType:'settled'}, false);
    expect(person.name).toBe('آزمون');
    expect(person.initialBalance).toBe(0);
    expect(changes.some(c => c.table === 'ledger_accounts' && c.row.code === person.accountingCode)).toBe(true);
    expect(changes.find(c => c.table === 'person_contacts')?.row.personId).toBe('p');
  });
  test('rejects a missing edit, invalid identity, and a reused detailed code', () => {
    expect(() => preparePersonRecord({}, {id:'missing',name:'x'}, true)).toThrow();
    expect(() => preparePersonRecord({}, {name:'   '}, false)).toThrow();
    expect(() => preparePersonRecord({persons:[{id:'a',accountingCode:'12010001'}]}, {id:'b',name:'x',accountingCode:'12010001'}, false)).toThrow();
  });
  test('preserves stored children when a partial edit omits them', () => {
    const {changes} = preparePersonRecord({persons:[{id:'p',name:'x',version:1}]}, {id:'p', name:'edited', version:1}, true);
    expect(changes.filter(c => c.table === 'person_contacts')).toEqual([]);
  });
});

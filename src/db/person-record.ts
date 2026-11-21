import { randomUUID } from 'node:crypto';
import { commitRows } from './commit-rows';
import { personSchema } from '../schemas/validation';
import { defaultLedgerAccounts } from '../utils/defaultLedgerAccounts';

const tables = ['persons', 'ledger_accounts', 'person_contacts', 'person_bank_accounts'] as const;
type Table = typeof tables[number];
type Row = Record<string, any>;
type Change = { table: Table; row: Row; remove?: boolean };

export function preparePersonRecord(data: Record<string, Row[]>, input: Row, editing: boolean) {
  const persons = data.persons || [];
  const id = String(input.id || randomUUID());
  if (editing && !input.id) throw new Error('شناسه شخص الزامی است');
  const old = persons.find(p => String(p.id) === id);
  if (old && input.personMutationId && old.personMutationId === input.personMutationId) return { person:old, changes:[] as Change[] };
  if (editing && !old) throw new Error('شخص پیدا نشد');
  if (!editing && old) throw new Error('این شناسه قبلاً ثبت شده است');
  if (editing && input.version != null && Number(input.version) !== Number(old.version || 1))
    throw new Error('پرونده هم‌زمان تغییر کرده است. دوباره بارگیری کنید.');
  const parsed = personSchema.safeParse({ ...old, ...input, id });
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => i.message).join('، '));
  const p: Row = { ...parsed.data, version: Number(old?.version || 0) + 1, updatedAt: Date.now(), createdAt: old?.createdAt || input.createdAt || Date.now() };
  if (p.initialBalanceType === 'settled') p.initialBalance = 0;
  if (p.initialBalance && (!['debtor','creditor'].includes(p.initialBalanceType) || !Number.isFinite(Number(p.initialBalance)) || Number(p.initialBalance) < 0))
    throw new Error('مبلغ و نوع مانده اولیه نامعتبر است');
  const changes: Change[] = [];
  const accounts = [...(data.ledger_accounts || [])];
  function account(row: Row) { accounts.push(row); changes.push({ table: 'ledger_accounts', row }); }
  if (!accounts.length) defaultLedgerAccounts(randomUUID).forEach(account);
  const prefix = p.role === 'supplier' ? '2101' : p.role === 'employee' ? '2102' : '1201';
  const general = accounts.find(a => a.code === prefix.slice(0,2));
  if (!general) throw new Error('حساب کل مرتبط تعریف نشده است');
  let parent = accounts.find(a => a.code === prefix);
  if (!parent) {
    parent = { id: randomUUID(), code: prefix, type: 'subsidiary', parentId: general.id, nature: general.nature, title: prefix === '1201' ? 'مشتریان' : prefix === '2101' ? 'تأمین‌کنندگان' : 'کارکنان' };
    account(parent);
  }
  const nextCode = (prefix: string, codes: unknown[]) => {
    let max = 0;
    for (const code of codes.map(String)) {
      const suffix = code.slice(prefix.length);
      if (code.startsWith(prefix) && /^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
    }
    return prefix + String(max + 1).padStart(4,'0');
  };
  p.accountingCode ||= nextCode(prefix, accounts.map(a => a.code));
  const linked = accounts.find(a => a.code === p.accountingCode);
  if (!/^\d{6,8}$/.test(p.accountingCode) || !p.accountingCode.startsWith(prefix) ||
      persons.some(a => String(a.id) !== id && a.accountingCode === p.accountingCode) ||
      (linked && (linked.type !== 'detailed' || String(linked.parentId ?? linked.parent_id) !== String(parent.id))))
    throw new Error('کد تفصیلی با معین یا مالک پرونده سازگار نیست');
  if (!linked) account({ id: randomUUID(), type: 'detailed', code: p.accountingCode, parentId: parent.id, nature: parent.nature, title: p.alias || p.name });
  p.personCode ||= nextCode(String(input.personCodePrefix || (p.role === 'supplier' ? '20' : p.role === 'employee' ? '30' : '10')), persons.map(a => a.personCode));
  delete p.personCodePrefix;
  if (persons.some(a => String(a.id) !== id && p.personCode && a.personCode === p.personCode)) throw new Error('کد شخص تکراری است');
  for (const [field, table] of [['contacts','person_contacts'],['bankAccounts','person_bank_accounts']] as const) {
    delete p[field];
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field])) throw new Error('اطلاعات تماس یا حساب نامعتبر است');
    const ids = new Set<string>();
    const children = data[table] || [];
    for (const child of input[field]) {
      const childId = String(child.id || randomUUID());
      if (ids.has(childId) || children.some(c => String(c.id) === childId && String(c.personId ?? c.person_id) !== id)) throw new Error('شناسه جزئیات تکراری است');
      ids.add(childId);
      changes.push({table, row: {...child, id: childId, personId: id}});
    }
    for (const row of children.filter(c => String(c.personId ?? c.person_id) === id && !ids.has(String(c.id)))) changes.push({table,row,remove:true});
  }
  changes.unshift({table:'persons',row:p});
  return { changes, person:p };
}

export async function writePerson(input: Row, editing: boolean) {
  return commitRows(tables, data => {
    const {changes, person} = preparePersonRecord(data, input, editing);
    return {changes, result:person};
  });
}

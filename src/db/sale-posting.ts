import { randomUUID } from 'node:crypto';
import { commitRows, type Change, type Row } from './commit-rows';
import { validateStockAvailability } from '../utils/stockLogic';
import { calculateAllProductsWAC, calculateInvoiceCOGS } from '../services/cogsService';
import { getChildTableCandidates } from './kv-store';
import { convertPriceToBaseUnit, getUnitRatioDirection } from '../utils/unitConversion';

const headers = ['invoices','sales_invoices','purchase_invoices','warehouse_receipts','warehouse_remittances','sale_returns','purchase_returns','wastes'];
const tables = [...new Set(['persons','ledger_accounts','financial_years','products','warehouses',...headers,
  ...headers.flatMap(getChildTableCandidates),'accounts','cashboxes','transactions','receipt_transactions','sales_invoice_payments',
  'accounting_documents','accounting_document_items','product_price_history','system_logs'])];
const same = (a: unknown,b: unknown) => a != null && b != null && String(a) === String(b);
const round = (x: number) => Math.round(x * 1e6) / 1e6;
function amount(value: unknown, label: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(label + ' نامعتبر است');
  return n;
}
function nextNumber(rows: Row[], field: string, prefix: string, start: number, length: number) {
  let max = start - 1;
  for (const row of rows) {
    const s = String(row[field] ?? '');
    if (s.startsWith(prefix) && /^\d+$/.test(s.slice(prefix.length))) max = Math.max(max,Number(s.slice(prefix.length)));
  }
  return prefix + String(max+1).padStart(length,'0');
}
function links(row: Row): Record<string,number> {
  return typeof row.linkedInvoices === 'string' ? JSON.parse(row.linkedInvoices) : {...row.linkedInvoices};
}

export function postSale(input: Row, settlement: Row, settings: Row, userId: string) {
  return commitRows(tables, data => {
    const rows = (table: string): Row[] => data[table] || [];
    const changes: Change[] = [];
    const put = (table: string,row: Row) => { changes.push({table,row}); };
    const remove = (table: string,row: Row) => { changes.push({table,row,remove:true}); };
    const now = Date.now();
    if (!input.id || !input.postingId) throw new Error('شناسه ثبت فاکتور الزامی است');
    const id = String(input.id);
    const old = rows('sales_invoices').find(r=>same(r.id,id)) || rows('invoices').find(r=>same(r.id,id));
    if (old?.postingId === input.postingId && !old.isDraft && old.status !== 'voided') {
      return {changes,result:{...old,items:rows('sales_invoice_items').filter(i=>same(i.invoiceId??i.invoice_id,id))}};
    }
    if (old && (!input.editing || old.isDeleted || old.status === 'voided' || Number(old.version || 1) !== Number(input.version || 1))) throw new Error('نسخه فاکتور تغییر کرده است. فاکتور را دوباره باز کنید');
    if (input.editing && !old) throw new Error('فاکتور برای ویرایش پیدا نشد');
    const customer = rows('persons').find(r=>same(r.id,input.customerId) && !r.isDeleted && r.isActive !== false);
    if (!customer) throw new Error('مشتری فعال یافت نشد');
    const date = String(input.date || '').slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) throw new Error('تاریخ فروش نامعتبر است');
    const year = rows('financial_years').find(y=>y.status==='open' && !y.isClosed && (!y.startDate || date >= String(y.startDate).slice(0,10)) && (!y.endDate || date <= String(y.endDate).slice(0,10)));
    if (!year) throw new Error('تاریخ فروش خارج از دوره مالی باز است');
    const base = settings.currency || 'تومان';
    const currency = input.currency || base;
    const rate = currency === base ? 1 : amount(input.exchangeRate,'نرخ ارز');
    if (!rate) throw new Error('نرخ ارز الزامی است');
    const ledger = (code: unknown) => {
      const account = rows('ledger_accounts').find(a=>code && same(a.code,code) && !a.isDeleted && a.isActive !== false);
      if (!account) throw new Error('حساب فعال برای کد ' + (code || 'تعریف‌نشده') + ' پیدا نشد');
      return account.id;
    };
    const personAccount = ledger(customer.accountingCode);
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('فاکتور بدون ردیف قابل ثبت نیست');
    let taxes = 0;
    const items: Row[] = input.items.map((item: Row)=>{
      const product = rows('products').find(p=>same(p.id,item.productId) && p.isActive !== false && !p.isDeleted && p.code);
      if (!product) throw new Error('کالای فعال دارای کد الزامی است');
      const warehouseId = item.warehouseId || input.warehouseId || product.warehouseId;
      if (product.type !== 'service' && !rows('warehouses').some(w=>same(w.id,warehouseId) && w.isActive !== false)) throw new Error('انبار ردیف معتبر نیست');
      const quantity = amount(item.quantity,'تعداد'), price = amount(item.unitPrice,'قیمت');
      const discount = amount(item.discountPercent || 0,'تخفیف');
      if (!quantity || discount > 100) throw new Error('تعداد یا تخفیف ردیف نامعتبر است');
      const tax = amount(item.tax || 0,'مالیات');
      taxes += tax;
      return {...item, id:randomUUID(), productId:product.id, warehouseId, quantity, unitPrice:price,
        unitRatio:product.unitRatio || 1, unitRatioDirection:getUnitRatioDirection(product), totalPrice:round(quantity*price*(1-discount/100)+tax)};
    });
    const discount = amount(input.overallDiscountPercent || 0,'تخفیف کل');
    if (discount > 100) throw new Error('تخفیف کل نامعتبر است');
    const total = round((items.reduce((n:number,i:Row)=>n+i.totalPrice,0)-taxes)*(1-discount/100)+taxes);
    if (Math.abs(total-amount(input.totalAmount,'جمع فاکتور'))>0.00001) throw new Error('جمع فاکتور با ردیف‌ها تطابق ندارد');
    const docs = new Map<string,Row>();
    for (const table of headers) {
      const children = getChildTableCandidates(table).flatMap(rows);
      for (const h of rows(table)) {
        const parts = children.filter(i=>same(i.invoiceId ?? i.invoice_id,h.id));
        docs.set(String(h.id),{...h,items:parts.length ? [...new Map(parts.map(i=>[String(i.id),i])).values()] : docs.get(String(h.id))?.items || h.items || []});
      }
    }
    const sales = [...docs.values()].filter(d=>d.type==='sale' || !d.type);
    const proposed = String(input.invoiceNumber || '').trim();
    const invoiceNumber = old?.invoiceNumber || (proposed && !proposed.includes('خودکار') ? proposed : nextNumber(sales,'invoiceNumber',settings.prefix_sale || 'INV-',Number(settings.start_sale)||1000,Number(settings.len_sale)||6));
    if (sales.some(r=>!same(r.id,id) && same(r.invoiceNumber,invoiceNumber))) throw new Error('شماره فاکتور تکراری است');
    const invoice: Row = {...input,id,invoiceNumber,date:input.date,type:'sale',isDraft:false,isDeleted:false,status:'final',fiscalYearId:year.id,customerId:customer.id,personId:customer.id,
      totalAmount:total,payableAmount:total,currency,exchangeRate:rate,version:old ? Number(old.version||1)+1 : 1,createdAt:old?.createdAt||now,updatedAt:now};
    delete invoice.items; delete invoice.editing; delete invoice.settlement; delete invoice.allowNegativeStock; delete invoice.previousTotal; delete invoice.existingPaid; delete invoice.expectedVersion;
    const available = validateStockAvailability({docToValidate:{...invoice,items},products:rows('products').map(p=>({...p})),warehouses:rows('warehouses'),allDocs:[...docs.values()],allowNegativeStock:[true,'true',1].includes(settings.allowNegativeStock)});
    if (!available.valid) throw new Error(available.error);
    const receiptMap = new Map<string,Row>();
    for (const r of [...rows('transactions'),...rows('receipt_transactions')]) {
      if (r.type==='receive' && !r.isDeleted && r.status!=='voided') receiptMap.set(String(r.id),r);
    }
    const receipts = [...receiptMap.values()];
    const existing = receipts.reduce((n,r)=>n+Number(links(r)[id]||0),0);
    if (existing && old && (!same(old.customerId,customer.id) || (old.currency||base)!==currency)) throw new Error('ابتدا تخصیص دریافت‌های قبلی اصلاح شود');
    const credit = amount(settlement.credit || 0,'اعتبار مصرفی');
    const cash = settlement.full ? round(total-existing-credit) : amount(settlement.cash || 0,'دریافت جدید');
    if (cash < 0 || round(existing+credit+cash)>total) throw new Error('جمع وصول و تخصیص از مبلغ فروش بیشتر است');
    const oldDoc = rows('accounting_documents').find(d=>d.sourceType==='invoice_sale' && !d.isDeleted && (same(d.sourceId,id)||same(d.sourceId,old?.invoiceNumber)));
    if (oldDoc?.isFinalized || oldDoc?.status==='permanent') throw new Error('سند قطعی فقط با سند اصلاحی قابل تغییر است');
    const journals = rows('accounting_documents');
    const articles = rows('accounting_document_items');
    const activeDocs = new Set(journals.filter(d=>!d.isDeleted && !['draft','voided'].includes(d.status) && !same(d.id,oldDoc?.id)).map(d=>String(d.id)));
    const balance = articles.filter(a=>same(a.detailedAccountId,customer.id) && activeDocs.has(String(a.documentId??a.document_id))).reduce((n,a)=>n+Number(a.debit||0)-Number(a.credit||0),0);
    if (Number(customer.creditLimit)>0 && balance+(total-cash)*rate>Number(customer.creditLimit)) throw new Error('سقف اعتبار مشتری کافی نیست');
    const paid = round(existing+credit+cash);
    Object.assign(invoice,{paidAmount:paid,paymentStatus:paid===0?'unpaid':paid===total?'paid':'partial'});
    for (const table of ['sales_invoices','invoices']) {
      put(table,invoice);
      const child = getChildTableCandidates(table)[0];
      rows(child).filter(i=>same(i.invoiceId??i.invoice_id,id)).forEach(i=>remove(child,i));
      items.forEach((i:Row)=>put(child,{...i,invoice_id:id,invoiceId:id}));
    }
    let remaining = credit;
    function allocate(receipt:Row, n:number) {
      const linked = links(receipt);
      linked[id] = round(Number(linked[id]||0)+n);
      const updated = {...receipt,linkedInvoices:linked};
      for (const table of ['receipt_transactions','transactions']) {
        if (rows(table).some(r=>same(r.id,receipt.id))) put(table,updated);
      }
      put('sales_invoice_payments',{id:receipt.id+'_'+id,invoiceId:id,receiptId:receipt.id,amount:linked[id],date:receipt.date});
    }
    for (const r of receipts) {
      if (remaining<=0) break;
      if (!same(r.personId,customer.id) || (r.currency||base)!==currency) continue;
      const free = Number(r.amount)-Object.values(links(r)).reduce((n,v)=>n+Number(v),0);
      if (free>0) { const n=Math.min(free,remaining); allocate(r,n); remaining=round(remaining-n); }
    }
    if (remaining>0) throw new Error('اعتبار تخصیص‌نیافته کافی نیست');
    const docNumbers=[...journals];
    function journal(sourceType:string,sourceId:string, lines:Row[], prior?:Row) {
      const docId=prior?.id || randomUUID();
      const doc={...prior,id:docId,documentNumber:prior?.documentNumber || nextNumber(docNumbers,'documentNumber','',1,4),sourceType,sourceId,date:input.date,status:'approved',fiscalYearId:year.id,currency:base,createdAt:prior?.createdAt||now,description:'فاکتور فروش '+invoiceNumber};
      docNumbers.push(doc); put('accounting_documents',doc);
      articles.filter(a=>same(a.documentId??a.document_id,docId)).forEach(a=>remove('accounting_document_items',a));
      for (const line of lines) put('accounting_document_items',{id:randomUUID(),documentId:docId,document_id:docId,debit:0,credit:0,currency:base,...line});
    }
    const gross=round(total*rate),tax=round(taxes*rate);
    const lines:Row[]=[{ledgerAccountId:personAccount,detailedAccountId:customer.id,debit:gross,description:'شخص'},{ledgerAccountId:ledger('41'),credit:round(gross-tax),description:'درآمد فروش'}];
    if (tax) lines.push({ledgerAccountId:ledger(settings.salesTaxAccountCode),credit:tax,description:'مالیات فروش'});
    const goods=items.filter((i:Row)=>rows('products').find(p=>same(p.id,i.productId))?.type!=='service');
    const history=[...docs.values()].filter(d=>!d.isDeleted && !d.isDraft && !['draft','voided','pending_approval'].includes(d.status) && String(d.date).slice(0,10)<=date);
    const costs=calculateAllProductsWAC(rows('products'),history.filter(d=>d.type==='purchase'),history.filter(d=>d.type==='warehouse_receipt'));
    const cost=round(calculateInvoiceCOGS({...invoice,items:goods},rows('products'),costs).totalCOGS);
    if (cost>0) lines.push({ledgerAccountId:ledger('51'),debit:cost,description:'بهای تمام‌شده فروش'},{ledgerAccountId:ledger('13'),credit:cost,description:'موجودی کالا'});
    journal('invoice_sale',id,lines,oldDoc);
    if (cash>0) {
      const bank=settlement.resourceType==='bank';
      const table=bank?'accounts':'cashboxes';
      const resource=rows(table).find(r=>same(r.id,settlement.resourceId) && r.isActive!==false && !r.isDeleted);
      if (!resource) throw new Error('حساب دریافت وجه معتبر نیست');
      const resourceAccount=ledger(resource.accountingCode);
      const resourceCurrency=resource.currency||base;
      if (resourceCurrency!==base && resourceCurrency!==currency) throw new Error('ارز حساب دریافت سازگار نیست');
      const converted=round(cash*rate);
      const priorBalance=Number(resource.balance??0);
      if (!Number.isFinite(priorBalance)) throw new Error('مانده منبع وجه نامعتبر است');
      put(table,{...resource,balance:round(priorBalance+(resourceCurrency===base?converted:cash))});
      const receipt={id:randomUUID(),type:'receive',receiptNumber:nextNumber(receipts,'receiptNumber',settings.prefix_receive_receipt||'REC-',1000,6),amount:cash,resourceAmount:resourceCurrency===base?converted:cash,exchangeRate:rate,currency,personId:customer.id,date:input.date,fiscalYearId:year.id,createdAt:now,resourceType:bank?'bank':'cashbox',resourceId:resource.id,method:bank?'card':'cash',linkedInvoices:{[id]:cash},description:'وصول فاکتور '+invoiceNumber};
      put('receipt_transactions',receipt);
      put('sales_invoice_payments',{id:receipt.id+'_'+id,invoiceId:id,receiptId:receipt.id,amount:cash,date:receipt.date});
      journal('receipt',receipt.id,[{ledgerAccountId:resourceAccount,debit:converted},{ledgerAccountId:personAccount,detailedAccountId:customer.id,credit:converted}]);
    }
    rows('product_price_history').filter(r=>same(r.invoiceId,id)).forEach(r=>remove('product_price_history',r));
    for (const item of items) put('product_price_history',{id:randomUUID(),invoiceId:id,invoiceItemId:item.id,productId:item.productId,type:'sale',date,quantity:item.quantity,originalUnitPrice:item.unitPrice,price:convertPriceToBaseUnit(item.unitPrice,!!item.isSecondaryUnit,item.unitRatio,item.unitRatioDirection)});
    put('system_logs',{id:randomUUID(),action:old?'UPDATE':'CREATE',entityType:'sales_invoices',entityId:id,userId,timestamp:now});
    return {changes,result:{...invoice,items}};
  });
}

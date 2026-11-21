export function defaultLedgerAccounts(generateId: () => string) {
    const assetsId = generateId();
    const liabilitiesId = generateId();
    const equityId = generateId();
    const incomeId = generateId();
    const expensesId = generateId();
    
    return [
      { id: assetsId, code: '1', title: 'دارایی‌ها', type: 'group', nature: 'debit', parentId: null },
      { id: liabilitiesId, code: '2', title: 'بدهی‌ها', type: 'group', nature: 'credit', parentId: null },
      { id: equityId, code: '3', title: 'حقوق صاحبان سهام', type: 'group', nature: 'credit', parentId: null },
      { id: incomeId, code: '4', title: 'درآمدها', type: 'group', nature: 'credit', parentId: null },
      { id: expensesId, code: '5', title: 'هزینه‌ها', type: 'group', nature: 'debit', parentId: null },
      
      { id: generateId(), code: '11', title: 'موجودی نقد و بانک', type: 'general', nature: 'debit', parentId: assetsId },
      { id: generateId(), code: '12', title: 'حساب‌ها و اسناد دریافتنی تجاری', type: 'general', nature: 'debit', parentId: assetsId },
      { id: generateId(), code: '13', title: 'موجودی مواد و کالا', type: 'general', nature: 'debit', parentId: assetsId },
      { id: generateId(), code: '14', title: 'پیش پرداخت‌ها', type: 'general', nature: 'debit', parentId: assetsId },
      { id: generateId(), code: '15', title: 'دارایی‌های ثابت', type: 'general', nature: 'debit', parentId: assetsId },
      
      { id: generateId(), code: '21', title: 'حساب‌ها و اسناد پرداختنی تجاری', type: 'general', nature: 'credit', parentId: liabilitiesId },
      { id: generateId(), code: '22', title: 'پیش دریافت‌ها', type: 'general', nature: 'credit', parentId: liabilitiesId },
      
      { id: generateId(), code: '31', title: 'سرمایه', type: 'general', nature: 'credit', parentId: equityId },
      
      { id: generateId(), code: '41', title: 'فروش کالا و خدمات', type: 'general', nature: 'credit', parentId: incomeId },
      
      { id: generateId(), code: '51', title: 'بهای تمام شده کالای فروش رفته', type: 'general', nature: 'debit', parentId: expensesId },
      { id: generateId(), code: '52', title: 'هزینه‌های حقوق و دستمزد', type: 'general', nature: 'debit', parentId: expensesId },
      { id: generateId(), code: '53', title: 'هزینه‌های اداری و تشکیلاتی', type: 'general', nature: 'debit', parentId: expensesId }
    ];
}

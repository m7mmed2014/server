require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

// ============================================================
// إعدادات قواعد البيانات (يجب التأكد من وجودها في ملف .env)
// ============================================================
const DATABASE_ID_GENERAL = process.env.NOTION_DATABASE_ID; // 1. قاعدة بيانات القوافل (الأساسية)
const DATABASE_ID_FINANCIAL = process.env.NOTION_DATABASE_ID_FINANCIAL; // 2. قاعدة بيانات المالي والبلاك ليست
const DATABASE_ID_USERS = process.env.NOTION_DATABASE_ID_USERS; // 3. قاعدة بيانات المستخدمين (تسجيل الدخول)
const DATABASE_ID_BLOCKLIST = process.env.Block_Ambassadors_ID; // 4. قاعدة بيانات حالات الحظر

// دالة مساعدة لاستخراج النصوص من نوشن بشكل آمن
const getText = (obj) => {
  if (!obj) return '';
  if (obj.type === 'title') return obj.title?.[0]?.plain_text || '';
  if (obj.type === 'rich_text') return obj.rich_text?.[0]?.plain_text || '';
  if (obj.type === 'number') return obj.number || '';
  if (obj.type === 'phone_number') return obj.phone_number || '';
  if (obj.type === 'formula') {
    if (obj.formula.type === 'string') return obj.formula.string || '';
    if (obj.formula.type === 'number') return obj.formula.number || '';
  }
  if (obj.type === 'select') return obj.select?.name || '';
  return 'N/A';
};

app.get('/api/search', async (req, res) => {
  const { q, type } = req.query; // نستلم نوع البحث (general أو financial) من الفرونت إند

  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  // ============================================================
  // المنطق: تحديد قاعدة البيانات بناءً على الزر الذي ضغط عليه المستخدم
  // ============================================================
  let currentDbId;
  let missingEnvVar;

  if (type === 'financial') {
    currentDbId = DATABASE_ID_FINANCIAL;
    missingEnvVar = 'NOTION_DATABASE_ID_FINANCIAL';
  } else {
    currentDbId = DATABASE_ID_GENERAL;
    missingEnvVar = 'NOTION_DATABASE_ID';
  }

  // التحقق من وجود الـ ID في ملف .env
  if (!currentDbId) {
    console.error(`Missing Environment Variable: ${missingEnvVar}`);
    return res.status(500).json({
      error: `Database configuration missing. Please add ${missingEnvVar} to your .env file.`
    });
  }

  try {
    // Build the query options
    const queryOptions = {
      filter: {
        or: [
          { property: 'اسم الحاله', title: { contains: q } },
          { property: 'الرقم القومي', rich_text: { contains: q } },
          { property: 'الزوج / هـ', rich_text: { contains: q } },
          { property: 'الرقم القومي للزوج / ة', rich_text: { contains: q } },
        ],
      },
    };

    // If type is financial, we want to search BOTH financial and blacklist databases
    const searchPromises = [notion.databases.query({ database_id: currentDbId, ...queryOptions })];
    if (type === 'financial' && DATABASE_ID_BLOCKLIST) {
      searchPromises.push(notion.databases.query({ database_id: DATABASE_ID_BLOCKLIST, ...queryOptions }).catch(() => ({ results: [] })));
    }

    const responses = await Promise.all(searchPromises);
    const allResults = responses.flatMap(res => res.results || []);

    // Resilient property finder (normalize keys and try multiple candidates)
    const normalizeKey = (s) => {
      if (!s) return '';
      return String(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[^0-9a-zA-Z\u0600-\u06FF ]/g, '');
    };

    const findProp = (props, keys) => {
      if (!props) return '';
      const normalizedMap = {};
      Object.keys(props || {}).forEach(k => { normalizedMap[normalizeKey(k)] = k; });

      // exact normalized match
      for (const k of keys) {
        const nk = normalizeKey(k);
        if (normalizedMap[nk]) {
          const val = getText(props[normalizedMap[nk]]);
          if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
        }
      }

      // partial match
      for (const k of keys) {
        const nk = normalizeKey(k);
        for (const propNorm in normalizedMap) {
          if (propNorm.includes(nk) || nk.includes(propNorm)) {
            const val = getText(props[normalizedMap[propNorm]]);
            if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
          }
        }
      }

      // token match
      for (const k of keys) {
        const nk = normalizeKey(k);
        for (const propNorm in normalizedMap) {
          if (nk.split(' ').every(token => token && propNorm.includes(token))) {
            const val = getText(props[normalizedMap[propNorm]]);
            if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
          }
        }
      }

      return '';
    };

    const results = allResults.map((page) => {
      const props = page.properties || {};
      const nameKeys = ['اسم الحاله', 'اسم الحالة', 'الاسم', 'Name', 'name'];
      const nidKeys = ['الرقم القومي', 'الرقم القومى', 'رقم قومي', 'الرقم القومي / قومي', 'الرقم'];
      const spouseKeys = ['الزوج / هـ','الزوج / هــــ','الزوج / هــ','الزوج','الزوجة','اسم الزوج','اسم الزوجة','الزوج / الزوجة'];
      const spouseNidKeys = ['الرقم القومي للزوج / ة','الرقم القومي للزوج / هـ','الرقم القومي للزوج','الرقم القومي للزوج/ه','رقم الزوجة','رقم الزوج'];
      const phone1Keys = ['تليفون 1','هاتف 1','الموبايل','تليفون','phone1','phone'];
      const phone2Keys = ['تليفون 2','هاتف 2','تليفون بديل','phone2'];
      const researcherKeys = ['اسم الباحث','الباحث','researcher'];
      const notesKeys = ['ملحوظات','ملاحظات','notes'];

      const result = {
        id: page.id,
        name: findProp(props, nameKeys) || getText(props['اسم الحاله']),
        nationalId: findProp(props, nidKeys) || getText(props['الرقم القومي']),
        spouse: findProp(props, spouseKeys) || getText(props['الزوج / هــ']) || getText(props['الزوج / هـ']) || '',
        spouseNationalId: findProp(props, spouseNidKeys) || getText(props['الرقم القومي للزوج / ه']) || getText(props['الرقم القومي للزوج / ة']) || '',
        status: findProp(props, ['الحاله','الحالة','status']) || getText(props['الحاله']),
        address: findProp(props, ['العنوان','address']) || getText(props['العنوان']),
        phone1: findProp(props, phone1Keys) || getText(props['تليفون 1']),
        phone2: findProp(props, phone2Keys) || getText(props['تليفون 2']),
        date: props['تاريخ القافله / تاريخ الجلسه']?.date?.start || '',
        recipientName: findProp(props, ['اسم المستلم','المستلم']) || getText(props['اسم المستلم']),
        recipientNationalId: findProp(props, ['الرقم القومي للمستلم','رقم المستلم']) || getText(props['الرقم القومي للمستلم']),
        relation: findProp(props, ['صله القرابه','صلة القرابه']) || getText(props['صله القرابه']),
        researcher: findProp(props, researcherKeys) || getText(props['اسم الباحث']),
        notes: findProp(props, notesKeys) || getText(props['ملحوظات']),
        databaseSource: page.parent.database_id.replace(/-/g, '') === DATABASE_ID_BLOCKLIST?.replace(/-/g, '') ? 'بلاك ليست' : (type === 'financial' ? 'سجل مالي' : 'قوافل'),
      };
      
      return result;
    });

    // Log first result for debugging
    if (results.length > 0) {
      console.log('[Search Result #1] Spouse:', results[0].spouse, '| SpouseNID:', results[0].spouseNationalId);
    }

    res.json({ count: results.length, data: results });

  } catch (error) {
    console.error('Notion API Error:', error);
    res.status(500).json({ error: 'Failed to fetch data from Notion. Check server logs.' });
  }
});

// ============================================================
// مسارات قائمة الحظر (Blocklist)
// ============================================================
app.get('/api/ambassadors-blacklist', async (req, res) => {
  if (!DATABASE_ID_BLOCKLIST) {
    console.error('Missing Block_Ambassadors_ID in .env');
    return res.status(500).json({ error: 'إعدادات قاعدة بيانات الحظر غير مكتملة في السيرفر' });
  }

  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID_BLOCKLIST,
    });

    const normalizeKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[^0-9a-zA-Z\u0600-\u06FF ]/g, '');
    const findProp = (props, keys) => {
      if (!props) return '';
      const normalizedMap = {};
      Object.keys(props).forEach(k => { normalizedMap[normalizeKey(k)] = k; });
      for (const k of keys) { const nk = normalizeKey(k); if (normalizedMap[nk]) { const val = getText(props[normalizedMap[nk]]); if (val) return String(val); } }
      for (const k of keys) { const nk = normalizeKey(k); for (const propNorm in normalizedMap) { if (propNorm.includes(nk) || nk.includes(propNorm)) { const val = getText(props[normalizedMap[propNorm]]); if (val) return String(val); } } }
      for (const k of keys) { const nk = normalizeKey(k); for (const propNorm in normalizedMap) { if (nk.split(' ').every(token => token && propNorm.includes(token))) { const val = getText(props[normalizedMap[propNorm]]); if (val) return String(val); } } }
      return '';
    };

    const results = response.results.map((page) => {
      const props = page.properties || {};
      const nameKeys = ['اسم الحاله', 'اسم الحالة', 'الاسم', 'Name', 'name'];
      const nidKeys = ['الرقم القومي', 'الرقم القومى', 'رقم قومي', 'الرقم القومي / قومي', 'الرقم'];
      const spouseKeys = ['الزوج / هـ', 'الزوج / هــــ', 'الزوج / هــ', 'الزوج', 'الزوجة', 'اسم الزوج', 'اسم الزوجة', 'الزوج / الزوجة'];
      const spouseNidKeys = ['الرقم القومي للزوج / ة', 'الرقم القومي للزوج / هـ', 'الرقم القومي للزوج', 'الرقم القومي للزوج/ه', 'رقم الزوجة', 'رقم الزوج'];
      const phone1Keys = ['تليفون 1', 'هاتف 1', 'الموبايل', 'تليفون', 'phone1', 'phone'];
      const phone2Keys = ['تليفون 2', 'هاتف 2', 'تليفون بديل', 'phone2'];
      const researcherKeys = ['اسم الباحث', 'الباحث', 'researcher'];
      const notesKeys = ['ملحوظات', 'ملاحظات', 'notes'];

      return {
        id: page.id,
        name: findProp(props, nameKeys),
        nationalId: findProp(props, nidKeys),
        spouse: findProp(props, spouseKeys),
        spouseNationalId: findProp(props, spouseNidKeys),
        phone1: findProp(props, phone1Keys),
        phone2: findProp(props, phone2Keys),
        researcher: findProp(props, researcherKeys),
        notes: findProp(props, notesKeys),
      };
    });

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Notion API Error (Ambassadors Blacklist GET):', error);
    res.status(500).json({ error: 'فشل في جلب بيانات الحظر من نوشن.' });
  }
});

app.post('/api/ambassadors-blacklist', async (req, res) => {
  if (!DATABASE_ID_BLOCKLIST) {
    return res.status(500).json({ error: 'إعدادات قاعدة بيانات الحظر غير مكتملة في السيرفر' });
  }

  const { name, nationalId, spouse, spouseNationalId, phone1, phone2, researcher, reason } = req.body;

  let notesText = `تم عمل بلوك للحاله بواسطه السفير ${researcher || 'غير معروف'} والسبب اللي فى ملاحظات: ${reason || 'لا يوجد'}`;
  if (spouse) notesText += `\nالزوج/ة: ${spouse}`;
  if (spouseNationalId) notesText += `\nالرقم القومي للزوج/ة: ${spouseNationalId}`;

  const safeParseNum = (val) => {
    if (!val) return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  };

  try {
    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID_BLOCKLIST },
      properties: {
        'اسم الحاله': {
          title: [{ text: { content: name || 'بدون اسم' } }],
        },
        'الرقم القومي': {
          number: safeParseNum(nationalId),
        },
        'تليفون 1': {
          number: safeParseNum(phone1),
        },
        'تليفون 2': {
          number: safeParseNum(phone2),
        },
        'اسم الباحث': {
          rich_text: [{ text: { content: researcher || '' } }],
        },
        'ملحوظات': {
          rich_text: [{ text: { content: notesText } }],
        },
      },
    });

    res.json({ success: true, message: 'تم إضافة الحالة إلى قائمة الحظر بنجاح', data: response });
  } catch (error) {
    console.error('Notion API Error (Ambassadors Blacklist POST):', error?.message, error?.body);
    res.status(500).json({
      error: 'فشل في إضافة الحالة لنوشن.',
      details: error?.message || 'خطأ غير معروف',
      body: error?.body || null
    });
  }
});

// ============================================================
// مسار تسجيل الدخول (Login)
// ============================================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  if (!DATABASE_ID_USERS) {
    console.error('Missing NOTION_DATABASE_ID_USERS in .env');
    return res.status(500).json({ success: false, message: 'إعدادات قاعدة بيانات المستخدمين غير مكتملة في السيرفر' });
  }

  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID_USERS,
      filter: {
        and: [
          {
            property: 'username',
            rich_text: {
              equals: username,
            },
          },
          {
            property: 'password',
            rich_text: {
              equals: password,
            },
          }
        ]
      }
    });

    if (response.results.length > 0) {
      // تم العثور على المستخدم وتطابق كلمة المرور
      res.json({ success: true, token: 'notion_valid_token_123', user: username });
    } else {
      res.json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء التحقق من بيانات الدخول' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
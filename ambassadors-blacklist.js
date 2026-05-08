require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');
const router = express.Router();

// Initialize Notion client
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const DATABASE_ID_BLOCKLIST = process.env.Block_Ambassadors_ID;
const FALLBACK_FILE = path.join(__dirname, 'data', 'ambassadors-blacklist-fallback.json');

// Helper function to extract text from Notion properties safely (more robust)
const getText = (obj) => {
  if (!obj) return '';
  const type = obj.type;
  try {
    if (type === 'title') return (obj.title || []).map(t => t.plain_text || '').join('') || '';
    if (type === 'rich_text') return (obj.rich_text || []).map(t => t.plain_text || '').join('') || '';
    if (type === 'number') return obj.number !== undefined && obj.number !== null ? String(obj.number) : '';
    if (type === 'phone_number') return obj.phone_number || '';
    if (type === 'email') return obj.email || '';
    if (type === 'select') return obj.select?.name || '';
    if (type === 'multi_select') return (obj.multi_select || []).map(s => s.name).join(', ') || '';
    if (type === 'people') return (obj.people || []).map(p => p.name || '').join(', ') || '';
    if (type === 'formula') {
      if (obj.formula.type === 'string') return obj.formula.string || '';
      if (obj.formula.type === 'number') return obj.formula.number !== undefined && obj.formula.number !== null ? String(obj.formula.number) : '';
      if (obj.formula.type === 'boolean') return obj.formula.boolean ? 'true' : 'false';
      return '';
    }
    if (type === 'date') return obj.date?.start || '';
    if (type === 'checkbox') return obj.checkbox ? 'true' : 'false';
  } catch (e) {
    return '';
  }

  // Fallbacks: try common fields
  return obj.rich_text?.[0]?.plain_text || obj.title?.[0]?.plain_text || obj.number || obj.phone_number || '';
};

// Normalize a string key for resilient matching (lowercase, remove punctuation/extra spaces)
const normalizeKey = (s) => {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[^0-9a-zA-Z\u0600-\u06FF ]/g, '');
};

// Try to find a property value by a list of candidate names using resilient matching
const findProp = (props, keys) => {
  if (!props) return '';
  const normalizedMap = {};
  Object.keys(props).forEach(k => { normalizedMap[normalizeKey(k)] = k; });

  // exact normalized match
  for (const k of keys) {
    const nk = normalizeKey(k);
    if (normalizedMap[nk]) {
      const val = getText(props[normalizedMap[nk]]);
      if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
    }
  }

  // partial match (contains)
  for (const k of keys) {
    const nk = normalizeKey(k);
    for (const propNorm in normalizedMap) {
      if (propNorm.includes(nk) || nk.includes(propNorm)) {
        const val = getText(props[normalizedMap[propNorm]]);
        if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
      }
    }
  }

  // as last resort, try any prop that contains key words
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

// GET /api/ambassadors-blacklist
router.get('/', async (req, res) => {
  if (!DATABASE_ID_BLOCKLIST) {
    console.error('Missing Block_Ambassadors_ID in .env');
    return res.status(500).json({ error: 'إعدادات قاعدة بيانات الحظر غير مكتملة في السيرفر' });
  }

  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID_BLOCKLIST,
    });

      // Debug: print property keys returned by Notion for diagnosis
      if (process.env.DEBUG_NOTION_KEYS === 'true') {
        try {
          const allKeys = new Set();
          (response.results || []).forEach(page => {
            const keys = page.properties ? Object.keys(page.properties) : [];
            console.log(`[NotionProps] page ${page.id}: ${keys.join(' | ')}`);
            keys.forEach(k => allKeys.add(k));
          });
          console.log('[NotionProps] aggregated property keys:', Array.from(allKeys).join(' | '));
        } catch (e) {
          console.warn('Failed to print Notion property keys:', e);
        }
      }

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
    // Attempt to serve fallback local data when Notion is unreachable
    try {
      if (fs.existsSync(FALLBACK_FILE)) {
        const raw = fs.readFileSync(FALLBACK_FILE, 'utf8');
        const fallbackData = JSON.parse(raw);
        console.warn('Using fallback ambassadors blacklist data from', FALLBACK_FILE);
        return res.json({ success: true, data: fallbackData });
      }
    } catch (e) {
      console.warn('Failed to load fallback data:', e);
    }

    res.status(500).json({ error: 'فشل في جلب بيانات الحظر من نوشن.' });
  }
});

// POST /api/ambassadors-blacklist
router.post('/', async (req, res) => {
  if (!DATABASE_ID_BLOCKLIST) {
    return res.status(500).json({ error: 'إعدادات قاعدة بيانات الحظر غير مكتملة في السيرفر' });
  }

  const { name, nationalId, spouse, spouseNationalId, phone1, phone2, researcher, reason } = req.body;

  // Build notes text — optional fields always go in notes as fallback
  let notesText = `تم عمل بلوك للحاله بواسطه الباحث ${researcher || 'غير معروف'} والسبب اللي فى ملاحظات: ${reason || 'لا يوجد'}`;
  if (spouse) notesText += `\nالزوج/ة: ${spouse}`;
  if (spouseNationalId) notesText += `\nالرقم القومي للزوج/ة: ${spouseNationalId}`;

  try {
    // Retrieve DB schema to map available property names
    let dbInfo = null;
    try {
      dbInfo = await notion.databases.retrieve({ database_id: DATABASE_ID_BLOCKLIST });
    } catch (err) {
      console.warn('Could not retrieve DB schema, will attempt fallback create:', err && err.message);
    }

    const nameKeys = ['اسم الحاله', 'اسم الحالة', 'الاسم', 'Name', 'name'];
    const nidKeys = ['الرقم القومي', 'الرقم القومى', 'رقم قومي', 'الرقم القومي / قومي', 'الرقم'];
    const spouseKeys = ['الزوج / هـ', 'الزوج / هــــ', 'الزوج / هــ', 'الزوج', 'الزوجة', 'اسم الزوج', 'اسم الزوجة', 'الزوج / الزوجة'];
    const spouseNidKeys = ['الرقم القومي للزوج / ة', 'الرقم القومي للزوج / هـ', 'الرقم القومي للزوج', 'الرقم القومي للزوج/ه', 'رقم الزوجة', 'رقم الزوج'];
    const phone1Keys = ['تليفون 1', 'هاتف 1', 'الموبايل', 'تليفون', 'phone1', 'phone'];
    const phone2Keys = ['تليفون 2', 'هاتف 2', 'تليفون بديل', 'phone2'];
    const researcherKeys = ['اسم الباحث', 'الباحث', 'researcher'];
    const notesKeys = ['ملحوظات', 'ملاحظات', 'notes'];

    const properties = {};

    if (!dbInfo) {
      // DB schema unavailable — try a minimal create using common property names
      properties['اسم الحاله'] = { title: [{ text: { content: name || 'بدون اسم' } }] };
      properties['ملحوظات'] = { rich_text: [{ text: { content: notesText + (spouse ? `\nزوج: ${spouse}` : '') + (spouseNationalId ? `\nالرقم القومي للزوج: ${spouseNationalId}` : '') } }] };
      const response = await notion.pages.create({ parent: { database_id: DATABASE_ID_BLOCKLIST }, properties });
      return res.json({ success: true, message: 'تم إضافة الحالة (نسخة احتياطية، لم يتم فحص بنية القاعدة)', data: response });
    }

    const dbProps = dbInfo.properties || {};

    const findPropKey = (propsObj, keys) => {
      if (!propsObj) return '';
      const map = {};
      Object.keys(propsObj).forEach(k => { map[normalizeKey(k)] = k; });
      for (const k of keys) { const nk = normalizeKey(k); if (map[nk]) return map[nk]; }
      for (const k of keys) { const nk = normalizeKey(k); for (const pk in map) { if (pk.includes(nk) || nk.includes(pk)) return map[pk]; } }
      for (const k of keys) { const nk = normalizeKey(k); for (const pk in map) { if (nk.split(' ').every(t => t && pk.includes(t))) return map[pk]; } }
      return '';
    };

    const findFirstOfType = (propsObj, type) => {
      for (const k of Object.keys(propsObj)) if (propsObj[k] && propsObj[k].type === type) return k;
      return '';
    };

    const nameKey = findPropKey(dbProps, nameKeys) || findFirstOfType(dbProps, 'title') || '';
    const nidKey = findPropKey(dbProps, nidKeys) || '';
    // spouse/spouseNid fields are intentionally kept in notes only (avoids Notion column mismatch errors)
    const phone1Key = findPropKey(dbProps, phone1Keys) || findFirstOfType(dbProps, 'number') || '';
    const phone2Key = findPropKey(dbProps, phone2Keys) || '';
    const researcherKey = findPropKey(dbProps, researcherKeys) || '';
    const notesKey = findPropKey(dbProps, notesKeys) || findFirstOfType(dbProps, 'rich_text') || '';

    const setPropVal = (propName, schema, value) => {
      if (!propName) return;
      const type = schema?.type;
      try {
        if (type === 'title') properties[propName] = { title: [{ text: { content: value || 'بدون اسم' } }] };
        else if (type === 'rich_text') properties[propName] = { rich_text: [{ text: { content: value || '' } }] };
        else if (type === 'number') {
          const num = value && String(value).replace(/\D/g, '') ? parseFloat(String(value).replace(/\D/g, '')) : null;
          properties[propName] = { number: num || null };
        } else if (type === 'phone_number') properties[propName] = { phone_number: value || '' };
        else if (type === 'select') properties[propName] = { select: { name: value || '' } };
        else properties[propName] = { rich_text: [{ text: { content: value || '' } }] };
      } catch (e) {
        // ignore schema mismatches and fallback
        properties[propName] = { rich_text: [{ text: { content: value || '' } }] };
      }
    };

    // Assign values to detected properties
    if (nameKey) setPropVal(nameKey, dbProps[nameKey], name || 'بدون اسم');
    if (nidKey) setPropVal(nidKey, dbProps[nidKey], nationalId || '');
    // spouse & spouseNationalId are embedded in notesText — no separate column needed
    if (phone1Key) setPropVal(phone1Key, dbProps[phone1Key], phone1 || '');
    if (phone2Key) setPropVal(phone2Key, dbProps[phone2Key], phone2 || '');
    if (researcherKey) setPropVal(researcherKey, dbProps[researcherKey], researcher || '');

    // Append any unresolved numeric fields to notes text
    let extraNotes = notesText;
    if (!nidKey && nationalId) extraNotes += `\nالرقم القومي: ${nationalId}`;
    if (!phone1Key && phone1) extraNotes += `\nتليفون1: ${phone1}`;
    if (!phone2Key && phone2) extraNotes += `\nتليفون2: ${phone2}`;

    if (notesKey) setPropVal(notesKey, dbProps[notesKey], extraNotes);
    else {
      const fallbackTextKey = findFirstOfType(dbProps, 'rich_text') || findFirstOfType(dbProps, 'title');
      if (fallbackTextKey) setPropVal(fallbackTextKey, dbProps[fallbackTextKey], extraNotes);
    }

    const response = await notion.pages.create({ parent: { database_id: DATABASE_ID_BLOCKLIST }, properties });
    res.json({ success: true, message: 'تم إضافة الحالة إلى قائمة الحظر بنجاح', data: response });
  } catch (error) {
    console.error('Notion API Error (Ambassadors Blacklist POST):', error);
    // Extract readable details from Notion API error
    let details = '';
    try {
      if (error.body) {
        const body = typeof error.body === 'string' ? JSON.parse(error.body) : error.body;
        details = body.message || body.code || '';
      } else if (error.message) {
        details = error.message;
      }
    } catch (_) { details = String(error); }
    res.status(500).json({ error: 'فشل في إضافة الحالة لنوشن', details });
  }
});

module.exports = router;

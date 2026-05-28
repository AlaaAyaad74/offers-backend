/** Product category taxonomy — slug stored in DB; object shape exposed in API `clear`. */
const PRODUCT_CATEGORIES = {
  general: { value: "general", label: "General", labelAr: "عام" },
  electronics: {
    value: "electronics",
    label: "Electronics",
    labelAr: "إلكترونيات",
  },
  fashion: { value: "fashion", label: "Fashion", labelAr: "أزياء" },
  beauty: { value: "beauty", label: "Beauty", labelAr: "جمال" },
  home: { value: "home", label: "Home", labelAr: "منزل" },
  automotive: {
    value: "automotive",
    label: "Automotive",
    labelAr: "سيارات",
  },
  food: { value: "food", label: "Food", labelAr: "طعام" },
  sports: { value: "sports", label: "Sports", labelAr: "رياضة" },
  baby: { value: "baby", label: "Baby", labelAr: "أطفال" },
  health: { value: "health", label: "Health", labelAr: "صحة" },
  toys: { value: "toys", label: "Toys", labelAr: "ألعاب" },
  books: { value: "books", label: "Books", labelAr: "كتب" },
};

/** Strong signals — checked before general keyword scoring. */
const CATEGORY_PRIORITY_RULES = [
  {
    id: "food",
    keywords: [
      /مربى|مربي|مرب(?!وع)/i,
      /جام\b|jam\b|عسل|زيتون|جبنة|جبن|لبن|زبادي|yogurt|cheese|honey/i,
      /طحينة|حلاوة|معلبات|grocery|snack\b/i,
    ],
  },
];

const CATEGORY_RULES = [
  {
    id: "electronics",
    keywords: [
      /تلفزيون|سماعات|لابتوب|هاتف|موبايل|شاحن|تابلت|كاميرا|ساعة\s*ذكية|smart\s*watch|phone|laptop|tv|earbuds|tablet|charger|electronic/i,
    ],
  },
  {
    id: "fashion",
    keywords: [
      /بلوفر|فستان|حذاء|ملابس|قميص|بنطلون|جاكيت|تيشيرت|مقاس\s*[XSML\d]|shirt|dress|shoes|fashion|clothing|sneaker/i,
    ],
  },
  {
    id: "beauty",
    keywords: [
      /كريم\s*(?:وجه|يد|بشرة|شعر|عين)|شامبو|مكياج|عطر|تفتيح|بشرة|ماسك\s*(?:وجه|شعر)?|beauty|shampoo|perfume|makeup|skincare|cosmetic/i,
      /face\s*cream|body\s*cream|hand\s*cream|hair\s*mask|face\s*mask/i,
    ],
  },
  {
    id: "home",
    keywords: [
      /مطبخ|منظم|حافظة|مستندات|أثاث|منزل|home|kitchen|furniture|organizer|storage/i,
    ],
  },
  {
    id: "automotive",
    keywords: [/سيار|سيارة|car\s|automotive|vehicle|محرك/i],
  },
  {
    id: "food",
    keywords: [
      /طعام|أكل|قهوة|شاي|food|grocery|snack|coffee|tea|عصير/i,
      /مربى|مربي|مرب(?!وع)|جام\b|jam\b|عسل|زيتون|جبنة|جبن|لبن|زبادي|yogurt|cheese|honey/i,
      /طحينة|حلاوة|معلبات|فواكة|فواكه|بسكويت|شوكولاتة|chocolate|biscuit/i,
    ],
  },
  {
    id: "sports",
    keywords: [/رياض|جيم|gym|sport|fitness|workout|yoga/i],
  },
  {
    id: "baby",
    keywords: [/أطفال|رضيع|baby|infant|kids|طفل/i],
  },
  {
    id: "health",
    keywords: [/فيتامين|صحة|دواء|health|vitamin|supplement|medical/i],
  },
  {
    id: "toys",
    keywords: [/لعبة|toy|games?\s+for\s+kids/i],
  },
  {
    id: "books",
    keywords: [/كتاب|book|novel|قراءة/i],
  },
];

function normalizeCategorySlug(raw) {
  if (raw == null || raw === "") return "general";
  const slug = String(raw).trim().toLowerCase();
  return PRODUCT_CATEGORIES[slug] ? slug : "general";
}

function toCategoryObject(slug) {
  const value = normalizeCategorySlug(slug);
  const def = PRODUCT_CATEGORIES[value];
  return {
    value: def.value,
    label: def.label,
    labelAr: def.labelAr,
  };
}

function listCategories() {
  return Object.values(PRODUCT_CATEGORIES);
}

function detectCategory(text) {
  if (!text) return "general";

  for (const rule of CATEGORY_PRIORITY_RULES) {
    for (const keyword of rule.keywords) {
      if (keyword.test(text)) {
        return rule.id;
      }
    }
  }

  let bestId = "general";
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (keyword.test(text)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = rule.id;
    }
  }

  return bestId;
}

module.exports = {
  PRODUCT_CATEGORIES,
  CATEGORY_PRIORITY_RULES,
  CATEGORY_RULES,
  normalizeCategorySlug,
  toCategoryObject,
  listCategories,
  detectCategory,
};

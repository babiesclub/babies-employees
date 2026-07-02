/**
 * annual-scheduler.js
 * ==================================================
 * אלגוריתם שיבוץ מערכים שנתי לבייביז קלאב
 * ==================================================
 *
 * גרסה ראשונה — 2026-07-02
 *
 * ⚠ מודול טהור: אין תלות ב-DOM, אין תלות ב-Firebase.
 * כל הקלטים כארגומנטים. הפונקציה הראשית: buildAnnualPlan(inputs)
 *
 * חוקי השיבוץ (בקצרה, מבוסס memory/project_babiez_material_rules.md):
 *   #1  אסור שמערך יחזור פעמיים באותה שנה"ל לאותו גן
 *   #2  רוטציה בין קטגוריות (מכרסם/כנף/זוחל/חרקים/אפרוח/generic)
 *   #3  חורף (דצמבר-פברואר) — ללא זוחלים / אפרוחים
 *   #4  אזורים עצמאיים
 *   #5  מותר לשכפל מערכים
 *   #6  ספירת "שודר" רק לפי records בפועל
 *   #7  Rotation Groups — Latin Square + one-way pipeline
 *   #8  חלונות חג "4 שבועות לפני" (dynamic per Hebrew calendar)
 *   #9  בחירת מערך הבא: last-aired at garden + category recency
 *       + seasonal window + variety from last week (מצטבר)
 *   #10 recompute באזור מוסיף/מוריד מדריכה (לא בגרסה זו — מטופל ב-UI)
 */

'use strict';

// ==================================================
// קבועים — מסונכרנים עם MAT_CATEGORIES ב-index.html
// ==================================================
const MAT_CATEGORIES = {
  rodent:  { label: 'מכרסם',       winterRisky: false },
  bird:    { label: 'בעלי כנף',    winterRisky: false },
  chick:   { label: 'אפרוח',       winterRisky: true  },  // חוק #3
  reptile: { label: 'זוחל',        winterRisky: true  },  // חוק #3
  insect:  { label: 'חרקים/זחלים', winterRisky: false },
  generic: { label: 'מערך כללי',   winterRisky: false }
};

// מיפוי חודשים לעונות — עקבי עם MAT_SEASONALITY ב-index.html
// JS months: 0=Jan ... 11=Dec
const SEASON_MONTHS = {
  any:     null,
  winter:  [11, 0, 1],
  spring:  [2, 3, 4],
  summer:  [5, 6, 7],
  autumn:  [8, 9, 10],
  near_rosh_hashana: [8, 9],
  near_purim: [1, 2],
  near_pesach: [2, 3],
  after_pesach: [3, 4, 5]
};

// חלונות "4 שבועות לפני חג" — עצמים חדשים שהוגדרו בזיכרון
// weeksBefore=4 → מקסימום עד 4 שבועות לפני תאריך החג בפועל
const HOLIDAY_WINDOW_SEASONS = {
  before_purim:        { anchor: 'purim',        weeksBefore: 4, weeksAfter: 0 },
  before_pesach:       { anchor: 'pesach',       weeksBefore: 4, weeksAfter: 0 },
  before_independence: { anchor: 'independence', weeksBefore: 4, weeksAfter: 0 },
  around_rosh_hashana_week: { anchor: 'roshHashana', weeksBefore: 1, weeksAfter: 1 }
};

const WINTER_MONTHS = [11, 0, 1]; // dec/jan/feb

// ברירות מחדל
const DEFAULT_START_DATE = '2026-09-06'; // ראשון
const DEFAULT_END_DATE   = '2027-08-08'; // שבת
const CATEGORY_RECENT_WEEKS = 4; // חוק #9: קטגוריה שלא קיבלה זמן (חודש אחורה)

// ==================================================
// עוזרות כלליות
// ==================================================

function toDate(s) {
  if (s instanceof Date) return new Date(s.getTime());
  return new Date(s + 'T00:00:00');
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getSunday(d) {
  const dt = new Date(d.getTime());
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() - dt.getDay());
  return dt;
}

function addDays(d, n) {
  const dt = new Date(d.getTime());
  dt.setDate(dt.getDate() + n);
  return dt;
}

function diffWeeks(a, b) {
  return Math.round((toDate(b) - toDate(a)) / (7 * 24 * 3600 * 1000));
}

// ==================================================
// חוק #3 — סינון חורף
// ==================================================
function isWinterWeek(weekStart) {
  return WINTER_MONTHS.includes(weekStart.getMonth());
}

function isWinterRisky(mat, weekStart) {
  if (!mat.category) return false;
  const cat = MAT_CATEGORIES[mat.category];
  if (!cat || !cat.winterRisky) return false;
  return isWinterWeek(weekStart);
}

// ==================================================
// חוק #8 — חלונות חג
// ==================================================
function computeHolidayWindow(holidayDateStr, weeksBefore, weeksAfter) {
  if (!holidayDateStr) return null;
  const anchor = toDate(holidayDateStr);
  const anchorSunday = getSunday(anchor);
  const start = addDays(anchorSunday, -7 * (weeksBefore || 0));
  const end = addDays(anchorSunday, 7 * (weeksAfter || 0));
  return { start, end };
}

// ==================================================
// חוק #9 — בדיקה: האם מערך נמצא בעונה
// ==================================================
function isMaterialInSeason(mat, weekStart, holidays) {
  const seasonality = mat.seasonality || 'any';
  if (seasonality === 'any') return true;

  // חלונות חג דינמיים
  if (HOLIDAY_WINDOW_SEASONS[seasonality]) {
    const spec = HOLIDAY_WINDOW_SEASONS[seasonality];
    const anchorDate = holidays && holidays[spec.anchor];
    if (!anchorDate) return true; // אם אין נתון — לא חוסם
    const win = computeHolidayWindow(anchorDate, spec.weeksBefore, spec.weeksAfter);
    return weekStart >= win.start && weekStart <= win.end;
  }

  // after_pesach — חלון של 4-12 שבועות אחרי פסח
  if (seasonality === 'after_pesach' && holidays && holidays.pesach) {
    const pesach = getSunday(toDate(holidays.pesach));
    const start = addDays(pesach, 4 * 7);
    const end = addDays(pesach, 12 * 7);
    return weekStart >= start && weekStart <= end;
  }

  // near_pesach / near_purim / near_rosh_hashana — עדיפות: קרוב לחג אם ידוע, אחרת חודשים
  if (seasonality === 'near_purim' && holidays && holidays.purim) {
    const w = computeHolidayWindow(holidays.purim, 4, 2);
    return weekStart >= w.start && weekStart <= w.end;
  }
  if (seasonality === 'near_pesach' && holidays && holidays.pesach) {
    const w = computeHolidayWindow(holidays.pesach, 4, 2);
    return weekStart >= w.start && weekStart <= w.end;
  }
  if (seasonality === 'near_rosh_hashana' && holidays && holidays.roshHashana) {
    const w = computeHolidayWindow(holidays.roshHashana, 4, 2);
    return weekStart >= w.start && weekStart <= w.end;
  }

  // fallback לפי חודשים
  const months = SEASON_MONTHS[seasonality];
  if (!months) return true;
  return months.includes(weekStart.getMonth());
}

// ==================================================
// חוק #2 + #9 — קטגוריה שלא הוצגה לאחרונה
// ==================================================
function categoryRecencyPenalty(mat, uid, categoryHistory) {
  if (!mat.category) return 0;
  const recent = (categoryHistory[uid] || []).slice(-CATEGORY_RECENT_WEEKS);
  if (!recent.includes(mat.category)) return 0;
  // אם הופיע בשבועות האחרונים — עונש כבד יותר ככל שהיה קרוב יותר
  const idx = recent.lastIndexOf(mat.category);
  return (recent.length - idx); // ככל שקרוב יותר לסוף — עונש גדול יותר
}

// חוק #9 — גיוון מהשבוע הקודם (soft-block)
function lastWeekSameCategoryPenalty(mat, uid, categoryHistory) {
  const hist = categoryHistory[uid] || [];
  if (!hist.length) return 0;
  const last = hist[hist.length - 1];
  return last === mat.category ? 5 : 0;
}

// ==================================================
// חוק #1 + #6 — האם הגן כבר "שמע" את החיה
// ==================================================
function gardensHaventHeard(mat, gardenNames, seenByGarden) {
  if (!mat.animalName) return gardenNames.length; // generic ללא חיה = תמיד חדש
  let count = 0;
  for (const g of gardenNames) {
    const heard = seenByGarden[g] || new Set();
    // חוק #6: לפי animalName של המערך
    if (mat.category === 'generic') {
      // generic לא סופר את החיה בגן — הוא לא נצמד לחיה
      count++;
      continue;
    }
    if (!heard.has(mat.animalName)) count++;
  }
  return count;
}

// ==================================================
// חישוב score למועמד — חוק #9 המצטבר
// ==================================================
function scoreMaterial(mat, uid, gardenNames, weekStart, ctx) {
  const { seenByGarden, categoryHistory, holidays } = ctx;

  // חוקים חוסמים (return -Infinity)
  if (mat.excludeFromAuto) return -Infinity;           // חוק #9 — 'כלב' לא אוטומטי
  if (isWinterRisky(mat, weekStart)) return -Infinity; // חוק #3
  if (!isMaterialInSeason(mat, weekStart, holidays)) return -Infinity; // חוק #9.3

  // חוק #1: מדריכה חופשית — אם כל הגנים שלה כבר שמעו — פסול
  const newFor = gardensHaventHeard(mat, gardenNames, seenByGarden);
  if (newFor === 0) return -Infinity;

  let score = 0;
  // 1) עדיפות עליונה: כמה גנים עוד לא שמעו (חוק #9.1)
  score += newFor * 100;

  // 2) חלון חג פעיל = בונוס גבוה (חוק #9.3)
  const isHolidayWindow = HOLIDAY_WINDOW_SEASONS[mat.seasonality]
    || ['near_purim', 'near_pesach', 'near_rosh_hashana', 'after_pesach'].includes(mat.seasonality);
  if (isHolidayWindow) score += 200;

  // 3) קטגוריה שלא קיבלה זמן (חוק #9.2)
  score -= categoryRecencyPenalty(mat, uid, categoryHistory) * 10;

  // 4) גיוון מהשבוע הקודם (חוק #9.4)
  score -= lastWeekSameCategoryPenalty(mat, uid, categoryHistory) * 5;

  return score;
}

// ==================================================
// ניהול קבוצת רוטציה — חוק #7 (Latin Square + Pipeline)
// ==================================================
/**
 * מבנה state לכל קבוצה:
 *   pipeline: [matId, matId, ..., matId]  // באורך cycleWeeks
 *   totalMatIntroduced: כמות מערכים שהוזרמו לפייפליין השנה
 *   history: מפה of {weekIndex → {uid: matId}}
 *
 * כל שבוע:
 *   1. הכנס מערך חדש לתחנה 0 (בחירת "המערך הבא")
 *   2. הזז את כל המערכים קדימה: pipeline[i] = pipeline[i-1]
 *   3. pipeline[last] יוצא מהמחזור השנה
 *   4. הקצה: instructor[k] יקבל pipeline[k]
 */
function initRotationGroupState(group) {
  const N = group.cycleWeeks || (group.instructorUids || []).length || 3;
  return {
    N,
    pipeline: new Array(N).fill(null), // מתחיל ריק
    weekIndex: 0,
    materialsUsedByGroup: new Set()    // חוק #7: כל מערך רק פעם אחת בקבוצה השנה
  };
}

function pickNextGroupMaterial(group, groupState, materials, weekStart, ctx) {
  // בחירה: מערך שעוד לא היה בקבוצה + עונתי + לא winter-risky בחורף
  // עדיפות: חלון חג פעיל, גיוון קטגוריות
  const { seenByGardenPerGroup, holidays } = ctx;
  const gardenSeenSet = seenByGardenPerGroup[group.id] || new Set();

  let best = null, bestScore = -Infinity;
  for (const mat of materials) {
    if (mat.excludeFromAuto) continue;
    if (groupState.materialsUsedByGroup.has(mat.id)) continue;
    if (isWinterRisky(mat, weekStart)) continue;
    if (!isMaterialInSeason(mat, weekStart, holidays)) continue;
    // חוק #1 עדיין תופס — אבל בגלל שאותו מערך לא חוזר בקבוצה, זה מובטח
    // (הגנים של קבוצה x פעם אחד בשנה יראו את המערך)

    let score = 100;
    // בונוס חלון חג
    const isHolidayWindow = HOLIDAY_WINDOW_SEASONS[mat.seasonality]
      || ['near_purim', 'near_pesach', 'near_rosh_hashana', 'after_pesach'].includes(mat.seasonality);
    if (isHolidayWindow) score += 200;

    // עדיפות קטגוריה שלא נראתה לאחרונה בקבוצה
    const recentInGroup = (ctx.groupCategoryHistory[group.id] || []).slice(-CATEGORY_RECENT_WEEKS);
    if (mat.category && recentInGroup.includes(mat.category)) score -= 20;

    // הימנע מלחזור על אותה קטגוריה משבוע קודם
    if (recentInGroup.length && mat.category === recentInGroup[recentInGroup.length - 1]) score -= 30;

    if (score > bestScore) { best = mat; bestScore = score; }
  }
  return best;
}

function assignGroupWeek(group, groupState, weekStart, materials, ctx, warnings) {
  const N = groupState.N;

  // 1) בחר מערך חדש לתחנה 0
  const newMat = pickNextGroupMaterial(group, groupState, materials, weekStart, ctx);
  if (!newMat) {
    warnings.push({
      type: 'group_no_material',
      weekId: ymd(weekStart),
      groupId: group.id,
      groupName: group.name
    });
  }

  // 2) הזז את הפייפליין קדימה
  //    - המערך בתחנה N-1 יוצא מהמחזור
  //    - כל האחרים זזים אחד קדימה
  //    - newMat נכנס לתחנה 0
  for (let i = N - 1; i > 0; i--) {
    groupState.pipeline[i] = groupState.pipeline[i - 1];
  }
  groupState.pipeline[0] = newMat ? newMat.id : null;
  if (newMat) groupState.materialsUsedByGroup.add(newMat.id);

  // 3) הקצה למדריכות (סדר instructorUids = סדר מסלול הנהג)
  const assignments = [];
  const instructorUids = group.instructorUids || [];
  for (let k = 0; k < Math.min(N, instructorUids.length); k++) {
    const matId = groupState.pipeline[k];
    assignments.push({ uid: instructorUids[k], matId });
  }

  // עקוב אחרי היסטוריית קטגוריה של הקבוצה
  if (newMat && newMat.category) {
    if (!ctx.groupCategoryHistory[group.id]) ctx.groupCategoryHistory[group.id] = [];
    ctx.groupCategoryHistory[group.id].push(newMat.category);
  }

  groupState.weekIndex++;
  return assignments;
}

// ==================================================
// שיבוץ מדריכה חופשית לשבוע
// ==================================================
function assignFreeInstructorWeek(instructor, weekStart, materials, ctx, warnings) {
  const uid = instructor.uid;
  const gardenNames = instructor.gardens || [];
  if (gardenNames.length === 0) {
    warnings.push({ type: 'instructor_no_gardens', uid, weekId: ymd(weekStart) });
    return null;
  }

  let best = null, bestScore = -Infinity;
  for (const mat of materials) {
    // חוק #5: מותר לשכפל מערכים — אבל לא לחזור לאותה מדריכה עם אותו מערך?
    // הזיכרון לא אומר במפורש; ברירת מחדל — לא לחזור באותה שנה למדריכה (soft)
    if ((ctx.seenByInstructor[uid] || new Set()).has(mat.id)) continue;

    const score = scoreMaterial(mat, uid, gardenNames, weekStart, ctx);
    if (score > bestScore) { best = mat; bestScore = score; }
  }

  if (!best) {
    warnings.push({ type: 'no_material_found', uid, weekId: ymd(weekStart) });
    return null;
  }
  return best;
}

// ==================================================
// פונקציה ראשית
// ==================================================
function buildAnnualPlan(inputs) {
  const {
    instructors = [],
    gardens = [],
    rotationGroups = [],
    materials = [],
    records = [],
    holidays = {},
    startDate = DEFAULT_START_DATE,
    endDate = DEFAULT_END_DATE
  } = inputs;

  const warnings = [];
  const weeklyPlan = [];

  // ===== STEP 1: הכנה =====
  const normalizedGardens = gardens.map(g => typeof g === 'string' ? { name: g } : g);
  const gardenByName = {};
  normalizedGardens.forEach(g => { gardenByName[g.name] = g; });

  // חשב אזור לגן — אם אין ב-object, גזור לפי המדריכה שאליה משוייך
  const instructorByUid = {};
  instructors.forEach(u => { instructorByUid[u.uid || u.id] = u; });

  for (const g of normalizedGardens) {
    if (g.region) continue;
    // מצא מדריכה שהגן שלה
    const owner = instructors.find(u => (u.gardens || []).includes(g.name));
    if (owner && owner.region) g.region = owner.region;
  }

  // בנה שבועות
  const start = getSunday(toDate(startDate));
  const end = toDate(endDate);
  const weeks = [];
  for (let d = new Date(start.getTime()); d <= end; d = addDays(d, 7)) {
    weeks.push(new Date(d.getTime()));
  }

  // חגי אין-פעילות
  const noActivityByWeek = (holidays.noActivity) || {};

  // ===== STEP 2: קיבוץ מדריכות ← אזור =====
  const regions = Array.from(new Set(instructors.map(u => u.region).filter(Boolean)));
  const instructorsByRegion = {};
  regions.forEach(r => { instructorsByRegion[r] = instructors.filter(u => u.region === r); });

  const groupsByRegion = {};
  regions.forEach(r => { groupsByRegion[r] = rotationGroups.filter(g => g.regionName === r); });

  // מדריכות "חופשיות" — לא בשום קבוצת רוטציה
  const groupedUids = new Set();
  rotationGroups.forEach(g => (g.instructorUids || []).forEach(u => groupedUids.add(String(u))));
  const freeByRegion = {};
  regions.forEach(r => {
    freeByRegion[r] = instructorsByRegion[r].filter(u => !groupedUids.has(String(u.uid || u.id)));
  });

  // ===== STEP 3: היסטוריית "שודר בגן" — מ-records בלבד (חוק #6) =====
  const seenByGarden = {}; // {gardenName: Set<animalName>}
  const startDateStr = ymd(start);
  const endDateStr = ymd(end);
  for (const r of records) {
    if (!r.date || !r.garden || !r.animalName) continue;
    if (r.date < startDateStr || r.date > endDateStr) continue;
    if (!seenByGarden[r.garden]) seenByGarden[r.garden] = new Set();
    seenByGarden[r.garden].add(r.animalName);
  }

  // ===== STEP 4: לולאה שבועית =====
  const seenByInstructor = {}; // {uid: Set<matId>}
  const categoryHistory = {};  // {uid: [cat, cat, ...]}
  const groupStates = {};      // {groupId: rotationGroupState}
  const groupCategoryHistory = {};
  const seenByGardenPerGroup = {}; // {groupId: Set<animalName>} — חוק #1 פר קבוצה

  rotationGroups.forEach(g => {
    groupStates[g.id] = initRotationGroupState(g);
    seenByGardenPerGroup[g.id] = new Set();
  });

  // מפוצל לצורך physicalUnits: usageInGroups[weekIndex][matId] = count
  const usageInGroupsPerWeek = []; // Array<Object<matId, count>>
  const freeUsersPerWeek = [];     // Array<Object<matId, count>>

  const ctx = {
    seenByGarden,
    seenByInstructor,
    categoryHistory,
    holidays,
    groupCategoryHistory,
    seenByGardenPerGroup
  };

  for (let wIdx = 0; wIdx < weeks.length; wIdx++) {
    const weekStart = weeks[wIdx];
    const weekEnd = addDays(weekStart, 6);
    const weekId = ymd(weekStart);
    const noAct = noActivityByWeek[weekId];

    const weekObj = {
      weekId,
      weekStart: ymd(weekStart),
      weekEnd: ymd(weekEnd),
      isHoliday: !!(noAct && noAct.fullWeek !== false),
      holidayName: noAct ? noAct.name : null,
      assignments: []
    };

    usageInGroupsPerWeek.push({});
    freeUsersPerWeek.push({});

    if (weekObj.isHoliday) {
      weeklyPlan.push(weekObj);
      continue;
    }

    // 4.1: קבוצות רוטציה (חוק #7)
    for (const region of regions) {
      for (const group of groupsByRegion[region]) {
        const gs = groupStates[group.id];
        const groupAssigns = assignGroupWeek(group, gs, weekStart, materials, ctx, warnings);
        for (const a of groupAssigns) {
          if (!a.matId) continue;
          const mat = materials.find(m => m.id === a.matId);
          const inst = instructorByUid[a.uid];
          if (!inst) continue;
          const gardenNames = inst.gardens || [];
          // עדכן seenByGarden — חוק #6 (אבל בגלל שזה עתידי — הוסף גם ל-seenByGardenPerGroup)
          for (const g of gardenNames) {
            if (!seenByGarden[g]) seenByGarden[g] = new Set();
            if (mat.animalName) seenByGarden[g].add(mat.animalName);
            seenByGardenPerGroup[group.id].add(mat.animalName);
          }
          // עדכן seenByInstructor + categoryHistory
          if (!seenByInstructor[a.uid]) seenByInstructor[a.uid] = new Set();
          seenByInstructor[a.uid].add(a.matId);
          if (!categoryHistory[a.uid]) categoryHistory[a.uid] = [];
          categoryHistory[a.uid].push(mat.category);

          weekObj.assignments.push({
            uid: a.uid,
            instructorName: inst.name,
            region,
            groupId: group.id,
            groupName: group.name,
            matId: a.matId,
            matName: mat.name,
            matAnimal: mat.animalName,
            matCategory: mat.category,
            gardens: gardenNames,
            gardensAlreadyHeard: []
          });

          usageInGroupsPerWeek[wIdx][a.matId] = (usageInGroupsPerWeek[wIdx][a.matId] || 0) + 1;
        }
      }
    }

    // 4.2: מדריכות חופשיות
    for (const region of regions) {
      for (const inst of freeByRegion[region]) {
        const uid = inst.uid || inst.id;
        const gardenNames = inst.gardens || [];
        const best = assignFreeInstructorWeek(inst, weekStart, materials, ctx, warnings);
        if (!best) continue;
        // עדכן היסטוריות
        for (const g of gardenNames) {
          if (!seenByGarden[g]) seenByGarden[g] = new Set();
          if (best.animalName) seenByGarden[g].add(best.animalName);
        }
        if (!seenByInstructor[uid]) seenByInstructor[uid] = new Set();
        seenByInstructor[uid].add(best.id);
        if (!categoryHistory[uid]) categoryHistory[uid] = [];
        categoryHistory[uid].push(best.category);

        weekObj.assignments.push({
          uid,
          instructorName: inst.name,
          region,
          groupId: null,
          groupName: null,
          matId: best.id,
          matName: best.name,
          matAnimal: best.animalName,
          matCategory: best.category,
          gardens: gardenNames,
          gardensAlreadyHeard: []
        });

        freeUsersPerWeek[wIdx][best.id] = (freeUsersPerWeek[wIdx][best.id] || 0) + 1;
      }
    }

    weeklyPlan.push(weekObj);
  }

  // ===== STEP 5: חישוב totals + physicalUnitsNeeded =====
  const materialTotals = {};

  for (const mat of materials) {
    let airings = 0;
    let peakGroups = 0;
    let peakFree = 0;
    const usedInGroups = new Set();
    const usedByFreeInstructors = new Set();

    for (let w = 0; w < weeks.length; w++) {
      const inGroups = usageInGroupsPerWeek[w][mat.id] || 0;
      const inFree = freeUsersPerWeek[w][mat.id] || 0;
      airings += inGroups + inFree;
      if (inGroups > peakGroups) peakGroups = inGroups;
      if (inFree > peakFree) peakFree = inFree;
    }

    // Detail: אלו קבוצות/חופשיות השתמשו
    for (const week of weeklyPlan) {
      for (const a of week.assignments) {
        if (a.matId !== mat.id) continue;
        if (a.groupId) usedInGroups.add(a.groupId);
        else usedByFreeInstructors.add(a.uid);
      }
    }

    // חישוב: physicalUnitsNeeded = peakGroups + peakFree
    // (peakGroups = מקסימום מספר קבוצות שהחזיקו במערך באותו שבוע)
    // (peakFree = מקסימום מספר מדריכות חופשיות שהעבירו את המערך באותו שבוע)
    materialTotals[mat.id] = {
      name: mat.name,
      animalName: mat.animalName,
      category: mat.category,
      seasonality: mat.seasonality,
      airings,
      physicalUnitsNeeded: peakGroups + peakFree,
      peakGroups,
      peakFree,
      usedInGroups: Array.from(usedInGroups),
      usedByFreeInstructors: Array.from(usedByFreeInstructors)
    };
  }

  return { weeklyPlan, materialTotals, warnings };
}

// ==================================================
// simulate() — הרצת סימולציה עם נתוני mock
// ==================================================
function simulate() {
  // 46 מערכים לדוגמה — 5 בכל קטגוריה + כמה עונתיים ידניים
  const materials = [];
  let id = 1;
  const push = (name, animal, category, seasonality, excludeFromAuto = false) => {
    materials.push({
      id: 'mat_' + id++,
      name,
      animalName: animal,
      category,
      seasonality: seasonality || 'any',
      excludeFromAuto
    });
  };
  // חלק מזוהה מהחוקים בזיכרון
  push('שליו', 'שליו', 'bird', 'before_pesach');
  push('יונת דואר', 'יונת דואר', 'bird', 'before_independence');
  push('יונת טווס', 'יונת טווס', 'bird', 'before_purim');
  push('צבע מהטבע', null, 'generic', 'any');
  push('עקבות בטבע', null, 'generic', 'any');
  push('וטרינר', null, 'generic', 'any');
  push('פרפר-זחלי משי', 'פרפר', 'insect', 'after_pesach');
  push('לובסטר', 'לובסטר', 'insect', 'summer');
  push('כלב', 'כלב', 'generic', 'any', true);
  push('חילזון', 'חילזון', 'insect', 'winter');
  push('דגים - ראש השנה', 'דגים', 'insect', 'near_rosh_hashana');
  push('דגים', 'דגים', 'insect', 'summer');
  push('דבורה דבש', 'דבורה', 'insect', 'near_rosh_hashana');
  push('אוגר סיבירי חורף', 'אוגר', 'rodent', 'winter');
  push('אביב - מסיבת חרקים', 'חרקים', 'insect', 'spring');
  // המשך: מכרסמים
  ['אוגר זהב', 'ארנב', 'מרמוט', 'שרקן', 'שנהב'].forEach(n => push(n, n, 'rodent', 'any'));
  // בעלי כנף
  ['תרנגול', 'תוכי', 'ינשוף', 'ברווז', 'תוכי סלמון'].forEach(n => push(n, n, 'bird', 'any'));
  // אפרוחים
  ['אפרוח סתם', 'אפרוח פסח', 'אפרוח סתיו', 'אפרוח אביב', 'אפרוח קייצי'].forEach(n => push(n, n, 'chick', 'any'));
  // זוחלים
  ['לטאה', 'חרדון', 'צב', 'זקן דרקון', 'קמלאון'].forEach(n => push(n, n, 'reptile', 'any'));
  // חרקים
  ['חיפושית', 'עכביש', 'צרעה', 'נמלים', 'ג׳וקים'].forEach(n => push(n, n, 'insect', 'any'));
  // generic נוספים
  ['בית חיות', 'בישול טבע', 'שירים על חיות', 'סיפורי חיות'].forEach(n => push(n, null, 'generic', 'any'));

  // ודא שיש בדיוק 46
  while (materials.length < 46) push('מערך #' + (materials.length + 1), 'חיה_' + materials.length, 'generic', 'any');
  materials.length = 46;

  // 5 מדריכות
  const instructors = [
    { uid: 'i1', name: 'רותי', region: 'דרום', gardens: ['גן א1', 'גן א2', 'גן א3', 'גן א4'] },
    { uid: 'i2', name: 'מיכל', region: 'דרום', gardens: ['גן ב1', 'גן ב2', 'גן ב3', 'גן ב4'] },
    { uid: 'i3', name: 'שירה', region: 'דרום', gardens: ['גן ג1', 'גן ג2', 'גן ג3', 'גן ג4'] },
    { uid: 'i4', name: 'נעה', region: 'מרכז', gardens: ['גן ד1', 'גן ד2', 'גן ד3', 'גן ד4'] },
    { uid: 'i5', name: 'תמר', region: 'שרון', gardens: ['גן ה1', 'גן ה2', 'גן ה3', 'גן ה4'] }
  ];

  // 20 גנים
  const gardens = [];
  ['א', 'ב', 'ג', 'ד', 'ה'].forEach((prefix, idx) => {
    const region = ['דרום', 'דרום', 'דרום', 'מרכז', 'שרון'][idx];
    for (let i = 1; i <= 4; i++) gardens.push({ name: 'גן ' + prefix + i, region });
  });

  // קבוצת רוטציה אחת — 3 מדריכות דרום
  const rotationGroups = [
    {
      id: 'rg1',
      name: 'קבוצת דרום',
      regionName: 'דרום',
      instructorUids: ['i1', 'i2', 'i3'],
      cycleWeeks: 3
    }
  ];

  // חגים לשנה"ל 2026-2027 (הערכה)
  const holidays = {
    roshHashana: '2026-09-12',
    purim: '2027-03-13',
    pesach: '2027-04-12',
    independence: '2027-04-27',
    noActivity: {
      // דוגמה — שבוע פסח
      '2027-04-11': { name: 'פסח', fullWeek: true }
    }
  };

  const records = []; // ריק — התחלת שנה

  return buildAnnualPlan({
    instructors,
    gardens,
    rotationGroups,
    materials,
    records,
    holidays,
    startDate: '2026-09-06',
    endDate: '2027-08-08'
  });
}

// ==================================================
// אקספורט
// ==================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildAnnualPlan,
    simulate,
    isMaterialInSeason,
    isWinterRisky,
    computeHolidayWindow,
    scoreMaterial,
    MAT_CATEGORIES,
    SEASON_MONTHS,
    HOLIDAY_WINDOW_SEASONS
  };
}

// אם רצים ישירות: הדפס סימולציה
if (typeof require !== 'undefined' && require.main === module) {
  const result = simulate();
  const totals = result.materialTotals;
  const sorted = Object.entries(totals)
    .sort((a, b) => b[1].physicalUnitsNeeded - a[1].physicalUnitsNeeded);

  console.log('====== SIMULATION RESULTS ======');
  console.log('Weeks planned:', result.weeklyPlan.length);
  console.log('Warnings:', result.warnings.length);
  console.log();
  console.log('Top 10 materials by physical units needed:');
  console.log('rank | matName | animal | cat | season | airings | physUnits | peakG | peakF');
  console.log('-----+---------+--------+-----+--------+---------+-----------+-------+------');
  sorted.slice(0, 10).forEach(([id, m], i) => {
    console.log(
      String(i + 1).padStart(4),
      '|', (m.name || '').padEnd(20),
      '|', (m.animalName || '-').padEnd(12),
      '|', (m.category || '-').padEnd(8),
      '|', (m.seasonality || '-').padEnd(20),
      '|', String(m.airings).padStart(5),
      '|', String(m.physicalUnitsNeeded).padStart(8),
      '|', String(m.peakGroups).padStart(5),
      '|', String(m.peakFree).padStart(5)
    );
  });

  console.log();
  const totalAirings = Object.values(totals).reduce((s, m) => s + m.airings, 0);
  const totalUnits = Object.values(totals).reduce((s, m) => s + m.physicalUnitsNeeded, 0);
  console.log('Total airings across all materials:', totalAirings);
  console.log('Total physical units needed (sum):', totalUnits);
  console.log('Materials with airings=0:',
    Object.values(totals).filter(m => m.airings === 0).length, '/ 46');

  console.log();
  console.log('Warning counts by type:');
  const wCounts = {};
  result.warnings.forEach(w => { wCounts[w.type] = (wCounts[w.type] || 0) + 1; });
  Object.entries(wCounts).forEach(([t, c]) => console.log(' ', t, ':', c));
}

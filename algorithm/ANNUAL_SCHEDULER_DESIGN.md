# אלגוריתם שיבוץ שנתי לבייביז קלאב

**תאריך:** 2026-07-02
**מטרה:** תכנון שנת לימודים 2026-2027 (6.9.2026 → 8.8.2027, כ-44 שבועות פעילות), כולל חישוב **מספר יחידות פיזיות** של כל מערך שצריך להחזיק במלאי.

---

## Phase A — סקר מצב + פערי מודל

### 1.1 מבני נתונים קיימים באפליקציה (`index.html`)

| קולקציה | מיקום | שדות רלוונטיים |
|--------|-------|--------------|
| `materials` (Firestore) → `bz3_materials` (LS) | `syncMaterials`, `getMaterials` | `id, name, animalName, summary, category, seasonality, excludeFromAuto, notes, instructorPdfUrl, gardenPdfUrl, audioFiles[], uploadedAt` |
| `meta/gardens` → `bz3_gardens` | `DB.get('gardens')` | גן = string או `{name, region, address, phone, monthlyChildCounts, ...}` |
| `users` → `bz3_users` | `DB.get('users')` | `{uid, id, name, username, role, specialty, region, gardens[], campsEnabled}` |
| `records` → `bz3_records` | `DB.get('records')` | `{instructorUid, instructorId, garden, animalName, date, ...}` |
| `weeklySchedule` → `bz3_weeklySchedule` | `getWeeklySchedule` | `{[weekId]: {weekStart, assignments:{[uid]:matId}, holidayOverride}}` |
| `rotationGroups` | `_rotGroups` / `syncRotGroups` | `{id, name, regionName, instructorUids[], cycleWeeks, materialPool[]}` |
| `regionRoutes` | `_regionRoutes` | `{[regionName]: {stops: [{kind:'group'\|'instructor', refId}]}}` |
| קבועים | `MAT_CATEGORIES`, `MAT_SEASONALITY`, `REGIONS`, `ISRAELI_HOLIDAYS` | `ISRAELI_HOLIDAYS` ריק (לא מולא), `MAT_CATEGORIES`+`MAT_SEASONALITY` כמו בזיכרון |

### 1.2 פערי מודל שזוהו

| פער | פירוט | פתרון באלגוריתם |
|-----|-------|-----------------|
| **`materialPool` בקבוצות** | השדה מוגדר בסכימה אבל האפליקציה עדיין לא ממלאת אותו בפועל | האלגוריתם יבחר את `materialPool` הראשוני לכל קבוצה (N מערכים לפי הקטגוריות המותרות בעונת ההתחלה) |
| **`ISRAELI_HOLIDAYS` ריק** | הקבועים מוגדרים אבל הטבלה ריקה | הקלט של האלגוריתם מקבל `holidays: {[weekId]: {name, fullWeek}}` — האדמין מזין ידנית / דרך פרמטרים |
| **תאריכי חג עברי (פורים/פסח/עצמאות/ראש השנה)** | לא מחושבים בקוד. חלון "4 שבועות לפני" דורש תאריך אבסולוטי | האלגוריתם מקבל `holidays: {purim, pesach, independence, roshHashana}` כתאריכים בפועל (YYYY-MM-DD) — לשנת 2026-2027 מזינים ידנית |
| **מספר יחידות פיזיות פר מערך** | לא קיים כלל בסכימה | הפלט של האלגוריתם: `physicalUnitsNeeded` פר `materialId` |
| **אזור לגן** | חלק מהגנים strings ישנים ללא region | אלגוריתם מסתמך על `garden.region` אם קיים, אחרת גוזר לפי אזור המדריכה |
| **תאריך התחלת שנה / סיום** | לא קבוע באפליקציה | האלגוריתם מקבל `startDate`, `endDate` כפרמטרים (ברירת מחדל: 2026-09-06 → 2027-08-08) |
| **מדריך "משוער" עבור camps** | `campsEnabled` קיים, אבל לא ברור אם משפיע על שנה"ל | הנחה: `campsEnabled` לא משפיע על השנה הרגילה — צוין כשאלה פתוחה |

### 1.3 הנחות עבודה

1. **44 שבועות בית ספר** — מ-2026-09-06 (א׳) עד 2027-08-08 (ש׳), מסונן בחגים שיוזנו ידנית ע"י המשתמשת.
2. **weekId = YYYY-MM-DD של ראשון** (עקבי עם `getSunday()` באפליקציה).
3. **חורף = דצמבר-פברואר** (חודשים 11,0,1 באינדקס JS) — כמו `MAT_SEASONALITY.winter`.
4. **אזור עצמאי** — כל אזור מריץ שיבוץ נפרד; הפלט אינטגרלי.
5. **מדריכה "חופשית"** (לא בקבוצת רוטציה) — מבצעת רוטציה אישית של מערך אחד בשבוע לכל הגנים שלה.
6. **גן עצמאי גם בתוך אזור** — היסטוריית "שודר לגן" נקבעת רק לפי `records` (חוק קריטי בזיכרון).
7. **generic materials** — יכולים להתאים לכל בעל חיים ולכן לא נתפסים לפי `animalName`.
8. **חוק "לא חוזר לאותו גן"** — משמעו: אותו `animalName` לא חוזר. שני מערכים generic הם שונים כי הם לא נצמדים לחיה.

---

## Phase B — עיצוב אלגוריתם

### 2.1 קלטים

```ts
buildAnnualPlan({
  instructors: [{uid, name, region, gardens: [gardenName]}],
  gardens: [{name, region}],           // או strings
  rotationGroups: [{id, name, regionName, instructorUids: [uid], cycleWeeks: N}],
  materials: [{id, name, animalName, category, seasonality, excludeFromAuto}],
  records: [{instructorUid, garden, animalName, date}],   // דיווחי ביקור
  holidays: {
    // חגים דתיים (לחישוב חלון "4 שבועות לפני")
    roshHashana: 'YYYY-MM-DD',
    purim: 'YYYY-MM-DD',
    pesach: 'YYYY-MM-DD',
    independence: 'YYYY-MM-DD',
    // שבועות ללא פעילות
    noActivity: {[weekId]: {name}}
  },
  startDate: 'YYYY-MM-DD',   // ברירת מחדל: 2026-09-06
  endDate: 'YYYY-MM-DD'      // ברירת מחדל: 2027-08-08
})
```

### 2.2 פלטים

```ts
{
  weeklyPlan: [
    {
      weekId, weekStart, weekEnd,
      isHoliday: bool,
      holidayName: string|null,
      assignments: [
        {
          uid, instructorName, region,
          groupId: string|null,          // אם בקבוצה
          matId, matName, matAnimal, matCategory,
          gardens: [gardenName],         // הגנים שיקבלו את המערך השבוע
          gardensAlreadyHeard: [gardenName]  // גנים שכבר שמעו (אזהרה)
        }
      ]
    }
  ],
  materialTotals: {
    [matId]: {
      name,
      airings: number,              // סך פעמים ששודר השנה
      physicalUnitsNeeded: number,  // מספר יחידות פיזיות
      peakSimultaneousUse: number,  // ערך שיא ששימש לחישוב
      usedInGroups: [groupId],      // באילו קבוצות רוטציה שימש
      usedByFreeInstructors: [uid]  // אילו מדריכות חופשיות השתמשו בו
    }
  },
  warnings: [
    { type: 'no_material_found', weekId, uid, reason },
    { type: 'garden_already_heard', weekId, uid, garden, matId },
    { type: 'winter_risky', weekId, uid, matId },
    ...
  ]
}
```

### 2.3 פסאודוקוד — צעד אחר צעד

```
STEP 1: הכנה
  1.1 נרמל גנים ל-{name, region}
  1.2 בנה מפה garden→region (region מהאובייקט, או גזר מהמדריכה)
  1.3 בנה מפה garden→instructorUid
  1.4 בנה weeks[] מ-startDate עד endDate בקפיצות של 7 ימים, החל מ-getSunday(startDate)
  1.5 סמן שבועות "אין פעילות" מ-holidays.noActivity
  1.6 חשב חלונות חגים: for each holiday in {purim, pesach, independence, roshHashana}:
        window = [holidayDate - 4weeks, holidayDate]  // חוק "4 שבועות לפני"
  1.7 בנה מאגר seasonalityGate(mat, weekStart) → true/false
      • any → תמיד true
      • winter/spring/summer/autumn → בדוק חודש
      • near_X / around_X → בדוק חלון
      • before_purim / before_pesach / before_independence → תוך window[holiday]
      • after_pesach → בין +4w ל +12w אחרי pesach
  1.8 בנה חוק חורף: dec/jan/feb → סנן category ∈ {chick, reptile}

STEP 2: קיבוץ מדריכות ← אזור
  לכל אזור R:
    instructorsInR = מדריכות עם region==R או מדריכות שהגנים שלהן ברובם ב-R
    groupsInR = rotationGroups עם regionName==R
    freeInstructors = instructorsInR - unionOf(groupsInR.instructorUids)

STEP 3: היסטוריית "שודר בגן" — מ-records בלבד (חוק קריטי)
  gardenHeard = {}  // {[gardenName]: Set<animalName>}
  for r in records:
    if r.date בטווח השנה הנוכחית (startDate → endDate):
      gardenHeard[r.garden].add(r.animalName)

STEP 4: לולאה שבועית
  seenByInstructor = {}  // {uid: Set<matId>} — מה המדריכה כבר קיבלה השנה
  seenByGarden = deepCopy(gardenHeard)  // {gardenName: Set<animalName>}
  categoryHistory = {}   // {uid: [lastN categories]}

  for each week W in weeks:
    if W.isHoliday.fullWeek:
      weeklyPlan.push({weekId: W.id, isHoliday:true, ...})
      continue

    for each region R:
      // 4.1 שיבוץ קבוצות רוטציה באזור
      for each group G in groupsInR:
        // Latin Square + one-way pipeline
        assignGroupWeek(G, W, materials, seasonalityGate, seenByGarden, warnings)
        // תוצאה: כל מדריכה ב-G קיבלה מערך מהפול הנוכחי
        // אם W % cycleWeeks == 0 → החלף את פול הקבוצה (נהג מביא N חדשים)

      // 4.2 שיבוץ מדריכות חופשיות באזור
      for each instructor U in freeInstructors:
        candidates = materials filtered by:
          - !excludeFromAuto
          - seasonalityGate(mat, W)
          - !winterBlock(mat, W)
          - mat לא בקטגוריה של השבוע הקודם של U (soft-block)
          - עבור generic — יבחר תמיד
        score כל candidate:
          + how many of U's gardens haven't heard this animal
          + boost if seasonal window active
          + boost if category not shown in last 4 weeks by U
        bestMat = argmax(score)
        if bestMat exists:
          assign U → bestMat for W
          for each garden in U.gardens: seenByGarden[garden].add(bestMat.animalName)
          categoryHistory[U.uid].push(bestMat.category)
        else:
          warnings.push({type:'no_material_found', uid:U.uid, weekId:W.id})

STEP 5: חישוב totals + physicalUnitsNeeded
  לכל material M:
    airings = count of (week, uid) pairs שקיבלו M
    peakSimultaneous = max over week W of:
      count of (uid × group) שבועיים שנעשה בהם M
    physicalUnitsNeeded = חישוב מפורט (ראה 2.4)
```

### 2.4 חישוב `physicalUnitsNeeded` — הליבה של מה שהמשתמשת רוצה

**הבנה מוצקה:** מערך פיזי הוא יחידה פיזית של בעל חיים / קיט שאפשר להעביר. אם יש 3 קבוצות רוטציה שכולן משתמשות בו-זמנית ב"שליו" באותו שבוע — צריך 3 יחידות פיזיות. אם רק מדריכה חופשית אחת משתמשת בו לאורך כל השנה — יחידה אחת מספיקה.

**הנחה קריטית:** בתוך קבוצת רוטציה של N מדריכות + N שבועות, כל שבוע N מערכים שונים משמשים במקביל (Latin Square). מערך שנכנס לפייפליין נשאר בפייפליין לאורך `cycleWeeks` שבועות אצל אותה קבוצה, אחרי זה פורש.

**הנוסחה:**

```
עבור כל מערך M:
  ownedByGroup[M] = 0   // בכמה קבוצות M נמצא בו-זמנית בפול?
  ownedByFree[M] = 0    // כמה מדריכות חופשיות מחזיקות במקביל?

לכל שבוע W:
  // 1. שימוש בקבוצות רוטציה
  usageInGroups[W][M] = מספר הקבוצות שבשבוע W יש בפול שלהן את M
  // 2. שימוש חופשי
  freeUsers[W][M] = מספר המדריכות החופשיות שקיבלו M בשבוע W

  peakGroups[M] = max over W of usageInGroups[W][M]
  peakFree[M] = max over W of freeUsers[W][M]

physicalUnitsNeeded[M] = peakGroups[M] + peakFree[M]
```

**דוגמאות מספריות:**

- **דוגמה 1: "שליו" (חלון פסח, 4 שבועות בלבד).**
  אם באזור דרום יש קבוצה אחת של 3 מדריכות ובאמצע החלון "שליו" נמצא בפול שלהן → `peakGroups=1`. אם באזור מרכז מדריכה חופשית מתחילה איתו באמצע החלון → `peakFree=1`. אם אין מקביליות בשבוע ספציפי → `physicalUnitsNeeded = 1 + 1 = 2`.

- **דוגמה 2: "חילזון" (חורף, מותר 3 חודשים).**
  אם 2 קבוצות מפעילות אותו במקביל ו-4 מדריכות חופשיות ברחבי הארץ → `physicalUnitsNeeded = 2 + 4 = 6`. (בפועל — פחות, כי לא הכל קורה באותו שבוע. הנוסחה לוקחת את השיא.)

- **דוגמה 3: "אוגר" (any, כל השנה).**
  ב-40 שבועות פוטנציאליים, אם השיא בשבוע כלשהו הוא 3 קבוצות + 5 מדריכות חופשיות → צריך 8 יחידות.

**הרחבה עתידית (לא נכנסת לגרסה זו):** אפשר לבצע smoothing שיפחית שיאים מיותרים ע"י shift-week של קבוצות. לא נדרש כרגע.

### 2.5 מקרי קצה שהאלגוריתם מטפל בהם

| מקרה | טיפול |
|------|-------|
| קבוצת רוטציה ריקה (`instructorUids=[]`) | דלג על הקבוצה + `warnings.push({type:'empty_group'})` |
| מדריכה ללא גנים | דלג עליה + `warnings.push({type:'instructor_no_gardens'})` |
| מערך ללא `seasonality` | הנח `any` |
| גן ללא `region` | גזור אזור לפי המדריכה שמשוייכת לו; אם אין — סמן `_unassigned` |
| חג נופל על שבוע האחרון של השנה | פשוט מדלג — הגן לא יקבל מערך באותו שבוע |
| מערך עם `excludeFromAuto=true` (כמו "כלב") | לא מועמד לאלגוריתם, יכול להשתבץ ידנית |
| שבוע ללא מערך מתאים | `warnings.push({type:'no_material_found'})` + השאר את התא ריק |
| מדריכה שגן שלה כבר שמע את כל החיות באזור | סובלנות — יאפשר generic; אם גם generic מוצה → warning |
| קבוצה עם `cycleWeeks` שונה מ-`instructorUids.length` | לוקח `cycleWeeks` כמקור אמת; מדריכות "עודפות" יקבלו null באותו שבוע |
| חלון חג "לפני פורים" אם pesach לא סופק | חלון לא פעיל — מסמן warning אחד לתחילת השנה |
| חלון חג שנופל בחגי בית-ספר | ה-4 שבועות שלפני עדיין נחשבים; שבועות ללא פעילות פשוט לא מקבלים |

---

## Phase C — Interface מודול

הפונקציות הציבוריות שהמודול `annual-scheduler.js` יחשוף:

```
buildAnnualPlan(inputs)
simulate()
// עוזרות
isMaterialAllowedForWeek(mat, weekStart, holidays)
isMaterialInSeason(mat, weekStart, holidays)
computeHolidayWindow(holidayDate, weeksBefore)
isWinterRisky(mat, weekStart)
categoryScore(mat, uid, categoryHistory)
gardenHeardScore(mat, gardens, seenByGarden)
```

הכל pure functions, ללא DOM וללא Firebase.

---

## Phase D — הפעלה בעתיד (מחוץ לתחום גרסה זו)

- אינטגרציה עם `weeklySchedule` באפליקציה (`setWschAssignment` + Firestore).
- הצגה כטבלה בטאב "אדמין ← שיבוץ שנתי".
- ייצוא Excel של דו"ח יחידות פיזיות → רשימת קניות.
- כפתור "רענן שיבוץ" עם חוק ההקפאה של +2 שבועות.

---

## שאלות פתוחות למשתמשת (יש להשיב לפני חישוב אמיתי)

1. **תאריכי חג בפועל לשנה"ל 2026-2027:**
   - ראש השנה 5787 → ?
   - פורים תשפ"ז → ?
   - פסח תשפ"ז → ?
   - יום העצמאות תשפ"ז → ?
2. **חופשות בית ספר** — מתי חנוכה, פסח, סוכות אצל הגנים?
3. **`campsEnabled`** — האם מדריכה עם קייטנות משבצת גם בקיץ, או שהיא לא במחזור השנתי הרגיל?
4. **מדריכות "מדריך יש כלב"** — האם יש רשימה של גנים שבהם כלב תמיד מותר?
5. **`cycleWeeks` לקבוצות רוטציה קיימות** — האם השיטה של "מחזור = כמות מדריכות" נשמרת?
6. **סף מינימלי לגיוון קטגוריה** — כמה שבועות אחורה נוסע חסום קטגוריה?
   - הזיכרון אומר "חודש אחורה" — לוקח את זה כ-4 שבועות אחורה.
7. **חומרה של soft-block** — האם בכלל לאפשר חזרה על קטגוריה בשבועות סמוכים אם אין אלטרנטיבה, או להעדיף לא לשבץ בכלל?
   - החלטת ברירת מחדל: soft-block שיקטין score אבל לא ייחסם לחלוטין.

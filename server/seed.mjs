/**
 * Fictional training dataset for the Qostanai Industry Hackathon prototype.
 * Names, equipment inventories, work records and assessments are synthetic.
 * Archive records deliberately contain no invented photographic evidence.
 */
export function createSeed(now = new Date()) {
  const anchor = new Date(now).getTime();
  if (!Number.isFinite(anchor)) throw new TypeError('createSeed requires a valid date');
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const iso = (value) => new Date(value).toISOString();
  const demoNote = 'Учебные данные: сотрудники, оборудование и записи вымышлены. Не являются производственными документами.';

  const sites = [
    { id: 'site-crushing', name: 'Дробильно-сортировочный комплекс' },
    { id: 'site-enrichment', name: 'Обогатительная фабрика' },
    { id: 'site-transport', name: 'Транспортно-конвейерный участок' },
    { id: 'site-workshop', name: 'Ремонтно-механический цех' },
  ];

  const brigades = [
    { id: 'brigade-1', name: 'Бригада №1 · Механики' },
    { id: 'brigade-2', name: 'Бригада №2 · Энергослужба' },
    { id: 'brigade-3', name: 'Бригада №3 · Ремонтный цех' },
  ];

  const employee = (id, name, login, role, specialty, grade = null, brigadeId = null, onShift = true) => ({
    id, name, login, role, specialty, grade, brigadeId, onShift,
    avatar: name.split(' ').slice(0, 2).map((part) => part[0]).join(''), pin: '1234',
  });
  const users = [
    employee('usr-master-1', 'Александр Смагулов', 'master', 'master', 'Мастер смены'),
    employee('usr-master-2', 'Ольга Нестерова', 'master2', 'master', 'Мастер смены', null, null, false),
    employee('usr-manager-1', 'Марат Алимов', 'manager', 'manager', 'Главный механик'),
    employee('usr-admin-1', 'Дарья Иванова', 'admin', 'admin', 'Администратор системы'),
  ];
  const workerRows = [
    ['Ерлан Ахметов', 'Слесарь-ремонтник', 6],
    ['Иван Петров', 'Электромонтёр', 5],
    ['Алексей Ким', 'Электросварщик', 5],
    ['Аслан Омаров', 'Слесарь-ремонтник', 5],
    ['Мария Волкова', 'Слесарь КИПиА', 6],
    ['Дмитрий Соколов', 'Слесарь-ремонтник', 6],
    ['Данияр Нурланов', 'Электромонтёр', 6],
    ['Сергей Белов', 'Электросварщик', 4],
    ['Тимур Сагындыков', 'Слесарь-ремонтник', 4],
    ['Анна Морозова', 'Слесарь КИПиА', 5],
    ['Максим Орлов', 'Слесарь-ремонтник', 5],
    ['Руслан Жумабаев', 'Электромонтёр', 4],
    ['Андрей Фомин', 'Электросварщик', 5],
    ['Арман Сериков', 'Слесарь-ремонтник', 4],
    ['Павел Новиков', 'Электромонтёр', 5],
  ];
  workerRows.forEach(([name, specialty, grade], index) => users.push(employee(
    `usr-worker-${index + 1}`, name, index === 0 ? 'worker' : `worker${index + 1}`,
    'worker', specialty, grade, `brigade-${Math.floor(index / 5) + 1}`, index < 12,
  )));
  const workers = users.filter((user) => user.role === 'worker');
  const userById = Object.fromEntries(users.map((user) => [user.id, user]));

  const equipmentRows = [
    ['eq-crusher-kmd1750', 'Дробилка КМД-1750', 'ДС-001', 'site-crushing', 'Дробилка', 'high'],
    ['eq-crusher-smd111', 'Щековая дробилка СМД-111', 'ДС-002', 'site-crushing', 'Дробилка', 'high'],
    ['eq-screen-1', 'Грохот ГИС-52 №1', 'ДС-003', 'site-crushing', 'Грохот', 'normal'],
    ['eq-screen-2', 'Грохот ГИС-52 №2', 'ДС-004', 'site-crushing', 'Грохот', 'normal'],
    ['eq-feeder-1', 'Пластинчатый питатель ПП-1', 'ДС-005', 'site-crushing', 'Питатель', 'high'],
    ['eq-aspiration-1', 'Аспирационная установка АУ-1', 'ДС-006', 'site-crushing', 'Вентиляция', 'high'],
    ['eq-cabinet-1', 'Шкаф управления дроблением ШУ-1', 'ДС-007', 'site-crushing', 'Электрооборудование', 'high'],
    ['eq-mill-1', 'Мельница МШР-2,1 №1', 'ОФ-001', 'site-enrichment', 'Мельница', 'high'],
    ['eq-mill-2', 'Мельница МШР-2,1 №2', 'ОФ-002', 'site-enrichment', 'Мельница', 'high'],
    ['eq-separator-1', 'Сепаратор СМ-1', 'ОФ-003', 'site-enrichment', 'Сепаратор', 'normal'],
    ['eq-pump-1', 'Насос пульповой НП-1', 'ОФ-004', 'site-enrichment', 'Насос', 'high'],
    ['eq-pump-2', 'Насос оборотной воды НВ-2', 'ОФ-005', 'site-enrichment', 'Насос', 'normal'],
    ['eq-fan-1', 'Вентилятор ВЦ-14 №1', 'ОФ-006', 'site-enrichment', 'Вентиляция', 'normal'],
    ['eq-cabinet-2', 'Преобразователь частоты ПЧ-2', 'ОФ-007', 'site-enrichment', 'Электрооборудование', 'high'],
    ['eq-k1', 'Ленточный конвейер К-1', 'ТК-001', 'site-transport', 'Конвейер', 'normal'],
    ['eq-k2', 'Ленточный конвейер К-2', 'ТК-002', 'site-transport', 'Конвейер', 'normal'],
    ['eq-k3', 'Ленточный конвейер К-3', 'ТК-003', 'site-transport', 'Конвейер', 'high'],
    ['eq-k4', 'Ленточный конвейер К-4', 'ТК-004', 'site-transport', 'Конвейер', 'normal'],
    ['eq-k5', 'Ленточный конвейер К-5', 'ТК-005', 'site-transport', 'Конвейер', 'normal'],
    ['eq-weigher-1', 'Конвейерные весы ВК-1', 'ТК-006', 'site-transport', 'КИПиА', 'normal'],
    ['eq-crane-1', 'Кран-балка КБ-5', 'ТК-007', 'site-transport', 'Подъёмное оборудование', 'high'],
    ['eq-hydraulic-1', 'Гидростанция ГС-12', 'РМ-001', 'site-workshop', 'Гидравлика', 'high'],
    ['eq-press-1', 'Пресс гидравлический ПГ-100', 'РМ-002', 'site-workshop', 'Гидравлика', 'high'],
    ['eq-compressor-1', 'Компрессор КВ-10', 'РМ-003', 'site-workshop', 'Компрессор', 'normal'],
    ['eq-lathe-1', 'Токарный станок 16К20', 'РМ-004', 'site-workshop', 'Станок', 'normal'],
    ['eq-welder-1', 'Сварочный источник ВД-306', 'РМ-005', 'site-workshop', 'Электрооборудование', 'normal'],
    ['eq-drill-1', 'Сверлильный станок 2Н135', 'РМ-006', 'site-workshop', 'Станок', 'normal'],
    ['eq-crane-2', 'Мостовой кран МК-10', 'РМ-007', 'site-workshop', 'Подъёмное оборудование', 'high'],
  ];
  const equipment = equipmentRows.map(([id, name, inventory, siteId, type, criticality]) => ({ id, name, inventory, siteId, type, criticality }));
  const equipmentById = Object.fromEntries(equipment.map((item) => [item.id, item]));

  const faultRows = [
    ['fault-bearing', 'М-01', 'Износ подшипникового узла', 'Слесарь-ремонтник', 2],
    ['fault-belt', 'М-02', 'Сход или повреждение конвейерной ленты', 'Слесарь-ремонтник', 3],
    ['fault-coupling', 'М-03', 'Износ эластичной муфты', 'Слесарь-ремонтник', 1.5],
    ['fault-gear', 'М-04', 'Повышенный люфт редуктора', 'Слесарь-ремонтник', 4],
    ['fault-fasteners', 'М-05', 'Ослабление крепежа', 'Слесарь-ремонтник', 1],
    ['fault-weld', 'М-06', 'Трещина сварного соединения', 'Электросварщик', 2.5],
    ['fault-screen', 'М-07', 'Износ ситовой поверхности', 'Слесарь-ремонтник', 2],
    ['fault-motor', 'Э-01', 'Перегрев электродвигателя', 'Электромонтёр', 2],
    ['fault-contactor', 'Э-02', 'Износ силовых контактов', 'Электромонтёр', 1],
    ['fault-cable', 'Э-03', 'Повреждение кабельной линии', 'Электромонтёр', 2.5],
    ['fault-drive', 'Э-04', 'Ошибка частотного преобразователя', 'Электромонтёр', 1.5],
    ['fault-limit', 'Э-05', 'Неисправность концевого выключателя', 'Электромонтёр', 1],
    ['fault-hydraulic', 'Г-01', 'Утечка гидравлического масла', 'Слесарь-ремонтник', 2],
    ['fault-pressure', 'Г-02', 'Падение давления гидросистемы', 'Слесарь-ремонтник', 2.5],
    ['fault-cylinder', 'Г-03', 'Износ уплотнений гидроцилиндра', 'Слесарь-ремонтник', 3],
    ['fault-air-leak', 'П-01', 'Утечка сжатого воздуха', 'Слесарь-ремонтник', 1.5],
    ['fault-air-filter', 'П-02', 'Засорение воздушного фильтра', 'Слесарь-ремонтник', 1],
    ['fault-lube', 'С-01', 'Недостаточная смазка узла', 'Слесарь-ремонтник', 0.75],
    ['fault-oil', 'С-02', 'Загрязнение редукторного масла', 'Слесарь-ремонтник', 1.5],
    ['fault-sensor', 'К-01', 'Сбой датчика контроля', 'Слесарь КИПиА', 1.5],
    ['fault-calibration', 'К-02', 'Отклонение показаний весов', 'Слесарь КИПиА', 2],
    ['fault-inspection', 'ТО-01', 'Регламентное техническое обслуживание', 'Слесарь-ремонтник', 1.5],
  ];
  const faults = faultRows.map(([id, code, name, specialty, normHours]) => ({ id, code, name, specialty, normHours }));
  const faultById = Object.fromEntries(faults.map((item) => [item.id, item]));

  const materialRows = [
    ['mat-bearing-22212', 'Подшипник 22212 EK', 'шт', 2],
    ['mat-bearing-6309', 'Подшипник 6309-2RS', 'шт', 2],
    ['mat-grease', 'Смазка Литол-24', 'кг', 0.5],
    ['mat-oil-hydraulic', 'Масло гидравлическое HVLP 46', 'л', 12],
    ['mat-oil-gear', 'Масло редукторное CLP 220', 'л', 8],
    ['mat-belt', 'Лента конвейерная 800 мм', 'м', 3],
    ['mat-roller', 'Ролик конвейерный 108×380', 'шт', 3],
    ['mat-seal-kit', 'Комплект уплотнений гидроцилиндра', 'компл', 1],
    ['mat-hose', 'Рукав высокого давления DN16', 'м', 2],
    ['mat-coupling', 'Вставка эластичной муфты МУВП', 'шт', 1],
    ['mat-bolts', 'Болт М16×60 класс 8.8', 'шт', 8],
    ['mat-nuts', 'Гайка М16 с шайбой', 'компл', 8],
    ['mat-electrodes', 'Электроды УОНИ-13/55 Ø3 мм', 'кг', 1],
    ['mat-wire', 'Проволока сварочная Св-08Г2С', 'кг', 1.5],
    ['mat-screen', 'Сито грохота 25×25 мм', 'шт', 2],
    ['mat-contactor', 'Контактор КМИ-22510 25А', 'шт', 1],
    ['mat-cable', 'Кабель ВВГнг 4×6 мм²', 'м', 8],
    ['mat-cable-tip', 'Наконечник кабельный ТМЛ-6', 'шт', 8],
    ['mat-limit', 'Выключатель концевой ВП15', 'шт', 1],
    ['mat-fuse', 'Предохранитель ППН-33 63А', 'шт', 3],
    ['mat-oil-filter', 'Фильтр гидравлический ФГ-25', 'шт', 1],
    ['mat-air-filter', 'Фильтр воздушный ФВ-10', 'шт', 1],
    ['mat-pneumatic-hose', 'Шланг пневматический PU 10×6,5', 'м', 3],
    ['mat-fitting', 'Фитинг прямой G1/4', 'шт', 2],
    ['mat-gasket', 'Прокладка паронитовая DN50', 'шт', 2],
    ['mat-sensor', 'Датчик индуктивный М18', 'шт', 1],
    ['mat-pressure-gauge', 'Манометр 0–16 МПа', 'шт', 1],
    ['mat-load-cell', 'Тензодатчик 1000 кг', 'шт', 1],
    ['mat-sealant', 'Герметик маслостойкий', 'шт', 1],
    ['mat-cleaner', 'Очиститель технический', 'л', 1],
    ['mat-cloth', 'Ветошь обтирочная', 'кг', 0.5],
    ['mat-grinding-disc', 'Круг зачистной 125×6 мм', 'шт', 2],
    ['mat-cutting-disc', 'Круг отрезной 125×1,6 мм', 'шт', 2],
    ['mat-steel', 'Лист стальной 4 мм', 'кг', 6],
    ['mat-insulation', 'Лента изоляционная ПВХ', 'шт', 1],
    ['mat-relay', 'Реле тепловое РТИ-2355', 'шт', 1],
    ['mat-vbelt', 'Ремень клиновой В-2000', 'шт', 2],
    ['mat-chain', 'Цепь приводная ПР-25,4', 'м', 2],
    ['mat-oring', 'Кольцо уплотнительное 45×3', 'шт', 4],
    ['mat-bushing', 'Втулка бронзовая 40×50×60', 'шт', 2],
    ['mat-key', 'Шпонка призматическая 14×9×70', 'шт', 1],
    ['mat-cable-tie', 'Стяжка кабельная 300 мм', 'шт', 10],
  ];
  const materials = materialRows.map(([id, name, unit, normalQuantity]) => ({ id, name, unit, normalQuantity }));
  const materialById = Object.fromEntries(materials.map((item) => [item.id, item]));
  const faultMaterials = {
    'fault-bearing': [['mat-bearing-22212', 2], ['mat-grease', 0.5]],
    'fault-belt': [['mat-belt', 3], ['mat-roller', 2]],
    'fault-coupling': [['mat-coupling', 1], ['mat-key', 1]],
    'fault-gear': [['mat-bearing-6309', 2], ['mat-oil-gear', 8]],
    'fault-fasteners': [['mat-bolts', 8], ['mat-nuts', 8]],
    'fault-weld': [['mat-electrodes', 1], ['mat-grinding-disc', 2]],
    'fault-screen': [['mat-screen', 2], ['mat-bolts', 8]],
    'fault-motor': [['mat-bearing-6309', 2], ['mat-insulation', 1]],
    'fault-contactor': [['mat-contactor', 1], ['mat-cable-tip', 4]],
    'fault-cable': [['mat-cable', 8], ['mat-cable-tip', 8]],
    'fault-drive': [['mat-relay', 1], ['mat-fuse', 3]],
    'fault-limit': [['mat-limit', 1], ['mat-cable-tie', 6]],
    'fault-hydraulic': [['mat-hose', 2], ['mat-oil-hydraulic', 12]],
    'fault-pressure': [['mat-oil-filter', 1], ['mat-oil-hydraulic', 12]],
    'fault-cylinder': [['mat-seal-kit', 1], ['mat-oil-hydraulic', 8]],
    'fault-air-leak': [['mat-pneumatic-hose', 3], ['mat-fitting', 2]],
    'fault-air-filter': [['mat-air-filter', 1], ['mat-cloth', 0.5]],
    'fault-lube': [['mat-grease', 0.5], ['mat-cloth', 0.5]],
    'fault-oil': [['mat-oil-gear', 8], ['mat-gasket', 2]],
    'fault-sensor': [['mat-sensor', 1], ['mat-cable-tie', 5]],
    'fault-calibration': [['mat-cleaner', 0.5], ['mat-cloth', 0.5]],
    'fault-inspection': [['mat-grease', 0.5], ['mat-cloth', 0.5]],
  };
  const worksByFault = {
    'fault-bearing': 'Демонтирован изношенный подшипниковый узел. Установлены два подшипника, выполнены центровка, смазка и контроль нагрева при пробном пуске.',
    'fault-belt': 'Восстановлен повреждённый участок ленты, заменены дефектные ролики. Отрегулированы натяжение и центровка, проверен ход ленты без нагрузки.',
    'fault-coupling': 'Заменена эластичная вставка муфты и шпонка. Проверены соосность валов, затяжка крепежа и отсутствие постороннего шума.',
    'fault-gear': 'Проведена ревизия редуктора, заменены подшипники и масло. Проверены боковой зазор, герметичность корпуса и работа под нагрузкой.',
    'fault-fasteners': 'Восстановлены резьбовые соединения и заменён повреждённый крепёж. Выполнена протяжка по карте обслуживания, нанесены контрольные метки.',
    'fault-weld': 'Дефектное соединение зачищено, трещина разделана и заварена. Выполнен визуальный контроль шва, восстановлено защитное покрытие.',
    'fault-screen': 'Заменены изношенные ситовые поверхности и крепления. Проверены равномерность натяжения, вибрация и отсутствие просыпи.',
    'fault-motor': 'Выполнена ревизия двигателя, заменены подшипники. Проверены сопротивление изоляции, ток фаз и температура на пробном пуске.',
    'fault-contactor': 'Заменён контактор с изношенными силовыми контактами. Выполнены протяжка клемм, проверка цепи управления и пять контрольных включений.',
    'fault-cable': 'Повреждённый участок кабеля заменён, установлены наконечники и маркировка. Изоляция и чередование фаз проверены до подачи напряжения.',
    'fault-drive': 'Проверены питание, цепи управления и параметры защиты преобразователя. Заменено неисправное реле, выполнен контрольный пуск без повторной ошибки.',
    'fault-limit': 'Заменён концевой выключатель. Положение срабатывания отрегулировано, блокировка проверена во всём диапазоне перемещения.',
    'fault-hydraulic': 'Заменён негерметичный рукав высокого давления, соединения протянуты. Восстановлен уровень масла, герметичность проверена под рабочим давлением.',
    'fault-pressure': 'Заменён фильтрующий элемент, проверен предохранительный клапан. Давление восстановлено до значения по паспорту, утечки при испытании не выявлены.',
    'fault-cylinder': 'Гидроцилиндр разобран, заменён комплект уплотнений. Выполнены сборка, удаление воздуха и проверка удержания нагрузки без просадки.',
    'fault-air-leak': 'Заменены повреждённый пневмошланг и фитинги. Соединения проверены на утечки, давление в линии стабильно.',
    'fault-air-filter': 'Заменён воздушный фильтр, очищен корпус. Проверены перепад давления и работа компрессора после обслуживания.',
    'fault-lube': 'Очищены пресс-маслёнки, выполнена дозированная смазка по карте обслуживания. Проверены подача смазки и температура узла.',
    'fault-oil': 'Отработанное масло слито, картер промыт. Заменены прокладки, залито свежее масло; уровень и герметичность проверены после запуска.',
    'fault-sensor': 'Заменён датчик, отрегулирован рабочий зазор. Проверены питание, сигнал на контроллере и устойчивость срабатывания.',
    'fault-calibration': 'Очищены узлы весов, проверены крепления и выполнена калибровка контрольной нагрузкой. Погрешность приведена к допустимому диапазону.',
    'fault-inspection': 'Выполнены регламентный осмотр, очистка, смазка и протяжка соединений. Проверены ограждения, блокировки и работа оборудования без нагрузки.',
  };

  const applicableFaults = (item) => {
    if (item.type === 'Гидравлика') return ['fault-hydraulic', 'fault-pressure', 'fault-cylinder', 'fault-inspection'];
    if (item.type === 'КИПиА') return ['fault-sensor', 'fault-calibration'];
    if (item.type === 'Электрооборудование') return ['fault-contactor', 'fault-cable', 'fault-drive', 'fault-motor'];
    if (item.type === 'Конвейер') return ['fault-belt', 'fault-bearing', 'fault-coupling', 'fault-limit', 'fault-weld', 'fault-lube'];
    if (item.type === 'Грохот') return ['fault-screen', 'fault-bearing', 'fault-fasteners', 'fault-weld'];
    if (item.type === 'Компрессор') return ['fault-air-leak', 'fault-air-filter', 'fault-motor', 'fault-inspection'];
    if (item.type === 'Подъёмное оборудование') return ['fault-limit', 'fault-cable', 'fault-gear', 'fault-weld'];
    return ['fault-bearing', 'fault-fasteners', 'fault-coupling', 'fault-motor', 'fault-lube', 'fault-oil', 'fault-inspection'];
  };

  const orders = [];
  let serial = 1000;
  const addEvent = (order, actorId, action, at, fromStatus, toStatus, comment = '') => {
    order.events.push({
      id: `${order.id}-event-${order.events.length + 1}`, actorId,
      actorName: userById[actorId]?.name ?? 'НарядAI · учебный анализ', action,
      ...(fromStatus ? { fromStatus } : {}), ...(toStatus ? { toStatus } : {}),
      at: iso(at), comment,
    });
  };
  const makeOrder = ({ id, equipmentId, faultId, assigneeId, created, due, type = 'planned', priority, title, description, comment }) => {
    const item = equipmentById[equipmentId];
    const fault = faultById[faultId];
    const assignee = userById[assigneeId];
    const masterId = serial % 4 === 0 ? 'usr-master-2' : 'usr-master-1';
    const order = {
      id, number: `Н-${++serial}`, title: title ?? `${type === 'planned' ? 'ТО: ' : ''}${fault.name}`,
      description: description ?? `${item.name}: ${fault.name.toLowerCase()}. Выполнить диагностику, устранение дефекта и контроль работоспособности по карте обслуживания.`,
      type, siteId: item.siteId, equipmentId, assigneeId, brigadeId: assignee.brigadeId,
      masterId, priority: priority ?? (type === 'planned' ? 'planned' : 'high'),
      status: 'issued', createdAt: iso(created), dueAt: iso(due), normHours: fault.normHours,
      faultId, comment: comment ?? demoNote, version: 1, photos: [], events: [],
    };
    addEvent(order, masterId, 'created', created, undefined, 'issued', 'Выдан наряд. Учебный набор данных.');
    return order;
  };

  const makeAssessment = (order, completed, score, highUsage = false, reworked = false, archived = true) => {
    const late = completed > new Date(order.dueAt).getTime();
    const findings = [
      { label: 'Полнота отчёта', status: 'pass', detail: 'Перечень работ, шифр неисправности и расход материалов заполнены.' },
      { label: 'Соответствие работ', status: 'pass', detail: 'В учебной записи описаны устранение дефекта и контрольный пуск.' },
      { label: 'Расход ТМЦ', status: highUsage ? 'warn' : 'pass', detail: highUsage ? 'Гидравлическое масло: расход превышает справочную норму 12 л более чем вдвое. Требуется проверить причину утечки.' : 'Количество материалов находится в пределах справочных норм учебного набора.' },
      { label: 'Срок исполнения', status: late ? 'warn' : 'pass', detail: late ? `Исполнение позже срока на ${Math.round((completed - new Date(order.dueAt).getTime()) / MINUTE)} мин.` : 'Исполнение зафиксировано до установленного срока.' },
      { label: 'Фотоподтверждение', status: 'warn', detail: archived ? 'Импортированный учебный архив без фотографий. Визуальная проверка не выполнялась; эта запись не подтверждает реальные работы.' : 'Плановое обслуживание: фото необязательно. Визуальный анализ не выполнялся.' },
    ];
    return {
      verdict: score >= 4 && !highUsage && !late ? 'accepted' : 'remarks', score,
      confidence: 0.78,
      summary: archived ? 'Учебная оценка архивной записи. Структура отчёта проверена; результат реального ремонта и качество по фото не подтверждались.' : 'Плановое обслуживание описано полно. Запись ожидает подтверждения мастера; оценка выполнена по правилам, без визуальной модели.',
      checks: findings,
      strengths: ['Указан шифр неисправности', 'Описан контроль работоспособности после обслуживания'],
      improvements: [
        ...(late ? ['Уточнить причины превышения срока и скорректировать планирование.'] : []),
        ...(highUsage ? ['Проверить повторную утечку и обосновать повышенный расход масла.'] : []),
        ...(reworked ? ['Сдавать полный отчёт с первого предъявления.'] : []),
        ...(archived ? ['Для реальных внеплановых работ приложить актуальное фото результата.'] : []),
      ],
      provider: 'demo-rules', reviewedAt: iso(completed + 2 * MINUTE),
    };
  };

  const addHistoric = ({ id, equipmentId, faultId, created, workerIndex = 0, type = 'planned', rework = false, highUsage = false, oilQuantity = 36, late = false, score, title, description }) => {
    const fault = faultById[faultId];
    const eligible = workers.filter((worker) => worker.specialty === fault.specialty);
    const assignee = eligible[workerIndex % eligible.length];
    const started = created + (10 + workerIndex % 15) * MINUTE;
    const duration = fault.normHours * HOUR * (late ? 1.45 : 0.68 + (workerIndex % 5) * 0.07);
    const due = created + (fault.normHours + 0.5) * HOUR;
    const firstCompleted = started + duration;
    const completed = firstCompleted + (rework ? 50 * MINUTE : 0);
    const order = makeOrder({ id, equipmentId, faultId, assigneeId: assignee.id, created, due, type, title, description });
    order.startedAt = iso(started);
    addEvent(order, assignee.id, 'transition', created + 5 * MINUTE, 'issued', 'accepted', 'Наряд принят исполнителем.');
    addEvent(order, assignee.id, 'transition', started, 'accepted', 'in_progress', 'Начато исполнение.');
    addEvent(order, assignee.id, 'completed', firstCompleted, 'in_progress', 'completed', 'Отчёт направлен на проверку.');
    addEvent(order, 'system-ai', 'ai_review', firstCompleted + MINUTE, 'completed', 'ai_review', 'Запущена проверка учебной записи по правилам.');
    if (rework) {
      addEvent(order, 'system-ai', 'assessment', firstCompleted + 2 * MINUTE, 'ai_review', 'rework', 'Не указан результат контрольного пуска. Дополнить выполненные работы и расход материалов.');
      addEvent(order, assignee.id, 'transition', firstCompleted + 8 * MINUTE, 'rework', 'in_progress', 'Принято в доработку.');
      addEvent(order, assignee.id, 'completed', completed, 'in_progress', 'completed', 'Добавлен результат контрольного пуска, уточнены материалы.');
      addEvent(order, 'system-ai', 'ai_review', completed + MINUTE, 'completed', 'ai_review', 'Повторная проверка отчёта.');
    }
    const usedMaterials = faultMaterials[faultId].map(([materialId, quantity]) => ({ materialId, quantity }));
    if (highUsage) {
      const oil = usedMaterials.find((item) => item.materialId === 'mat-oil-hydraulic');
      if (oil) oil.quantity = oilQuantity;
      else usedMaterials.push({ materialId: 'mat-oil-hydraulic', quantity: oilQuantity });
    }
    order.completion = {
      works: worksByFault[faultId], faultId, materials: usedMaterials,
      comment: highUsage ? 'Учебный пример: масло израсходовано на долив после повторной утечки. Причина повышенного расхода требует отдельной диагностики.' : 'Учебный архив; фотографии не импортировались. Результаты не относятся к реальному производству.',
      submittedAt: iso(completed),
    };
    order.completedAt = iso(completed);
    order.assessment = makeAssessment(order, completed, score ?? (rework || highUsage ? 3 : late ? 4 : workerIndex % 4 === 0 ? 4 : 5), highUsage, rework);
    order.assessment.masterScore = order.assessment.score;
    order.assessment.masterComment = 'Учебная архивная запись. Подтверждение мастера смоделировано для демонстрации полного жизненного цикла.';
    addEvent(order, 'system-ai', 'assessment', completed + 2 * MINUTE, undefined, undefined, `Учебная оценка: ${order.assessment.score}/5. Фотопроверка не выполнялась.`);
    addEvent(order, order.masterId, 'closed', completed + 12 * MINUTE, 'ai_review', 'closed', order.assessment.masterComment);
    order.status = 'closed';
    order.closedAt = iso(completed + 12 * MINUTE);
    order.version = order.events.length;
    orders.push(order);
    return order;
  };

  // Six jobs per day over 94 days. Dates follow the first startup date, not a fixed demo date.
  for (let index = 0; index < 560; index += 1) {
    const item = equipment[(index * 11) % equipment.length];
    const eligibleFaults = applicableFaults(item);
    const faultId = eligibleFaults[Math.floor(index / equipment.length) % eligibleFaults.length];
    const fault = faultById[faultId];
    const eligibleWorkers = workers.filter((worker) => worker.specialty === fault.specialty);
    const workerIndex = Math.floor(index / 3) + index % 7;
    const assignee = eligibleWorkers[workerIndex % eligibleWorkers.length];
    // Deliberately concentrated returns in the third brigade, visible in event-derived analytics.
    const rework = assignee.brigadeId === 'brigade-3' ? index % 3 === 0 : index % 31 === 0;
    addHistoric({
      id: `hist-${String(index + 1).padStart(4, '0')}`, equipmentId: item.id, faultId, workerIndex,
      created: anchor - 94 * DAY + Math.floor(index / 6) * DAY + (index % 6) * 90 * MINUTE,
      rework, late: index % 11 === 0,
    });
  }

  // Planted pattern 1: seven repeated bearing failures on conveyor K-3 in the last three weeks.
  [21, 18, 15, 12, 9, 6, 3].forEach((days, index) => addHistoric({
    id: `pattern-k3-${index + 1}`, equipmentId: 'eq-k3', faultId: 'fault-bearing',
    created: anchor - days * DAY - 6 * HOUR, workerIndex: index,
    type: 'unplanned', late: index % 3 === 0,
    title: 'Повторный перегрев подшипника приводного барабана',
    description: 'Конвейер К-3: повторный нагрев и шум подшипникового узла приводного барабана. Проверить соосность, натяжение ленты и подачу смазки; устранить причину повторения.',
  }));

  // Planted pattern 2: six documented oil consumptions 2.7–4× above the catalog norm.
  [27, 23, 19, 14, 10, 4].forEach((days, index) => addHistoric({
    id: `pattern-oil-${index + 1}`, equipmentId: 'eq-hydraulic-1', faultId: 'fault-hydraulic',
    created: anchor - days * DAY - 10 * HOUR, workerIndex: index + 2,
    type: 'unplanned', highUsage: true, oilQuantity: [32, 38, 36, 42, 48, 40][index],
    title: 'Утечка масла на гидростанции ГС-12',
    description: 'Гидростанция ГС-12: снижение уровня масла, следы течи на напорной линии. Найти негерметичное соединение, восстановить герметичность и проверить расход масла.',
  }));

  // Planted pattern 3: failure within 48 hours of scheduled service, on four occasions.
  [76, 53, 32, 8].forEach((days, index) => {
    addHistoric({
      id: `pattern-service-${index + 1}`, equipmentId: 'eq-crusher-kmd1750', faultId: 'fault-inspection',
      created: anchor - days * DAY - 8 * HOUR, workerIndex: index + 4,
      title: 'Плановое ТО дробилки КМД-1750',
    });
    addHistoric({
      id: `pattern-after-service-${index + 1}`, equipmentId: 'eq-crusher-kmd1750', faultId: 'fault-bearing',
      created: anchor - (days - 2) * DAY - 10 * HOUR, workerIndex: index + 2,
      type: 'unplanned', rework: index % 2 === 0, late: true,
      title: 'Перегрев узла после планового ТО',
      description: 'Дробилка КМД-1750: после недавнего обслуживания зафиксирован рост температуры подшипников. Проверить качество сборки и фактическую подачу смазки.',
    });
  });

  // Several completed jobs from the current shift keep the shift dashboard meaningful.
  for (let index = 0; index < 5; index += 1) addHistoric({
    id: `shift-closed-${index + 1}`, equipmentId: ['eq-k1', 'eq-pump-1', 'eq-fan-1', 'eq-lathe-1', 'eq-k4'][index],
    faultId: 'fault-lube', workerIndex: index + 1, created: anchor - (7 - index) * HOUR,
  });

  const liveRows = [
    { id: 'live-001', equipmentId: 'eq-k3', faultId: 'fault-bearing', worker: 1, status: 'in_progress', createdAgo: 150, dueIn: -35, priority: 'emergency', title: 'Перегрев подшипника конвейера К-3', comment: 'Температура корпуса повышена. Подшипник получен со склада, выполняется замена. Учебный сценарий.' },
    { id: 'live-002', equipmentId: 'eq-crusher-kmd1750', faultId: 'fault-fasteners', worker: 1, status: 'issued', createdAgo: 8, dueIn: 120, priority: 'high', title: 'Проверить крепления дробилки КМД-1750' },
    { id: 'live-003', equipmentId: 'eq-k2', faultId: 'fault-lube', worker: 1, status: 'queued', createdAgo: 100, dueIn: 240, priority: 'planned', type: 'planned', title: 'Регламентная смазка приводного узла К-2' },
    { id: 'live-004', equipmentId: 'eq-cabinet-1', faultId: 'fault-contactor', worker: 2, status: 'in_progress', createdAgo: 80, dueIn: 25, priority: 'high', title: 'Заменить контактор шкафа ШУ-1' },
    { id: 'live-005', equipmentId: 'eq-feeder-1', faultId: 'fault-weld', worker: 3, status: 'paused', createdAgo: 180, dueIn: -20, priority: 'high', title: 'Восстановить сварной шов питателя ПП-1', comment: 'Ожидается остановка смежной линии и оформление допуска. Учебный сценарий.' },
    { id: 'live-006', equipmentId: 'eq-pump-1', faultId: 'fault-bearing', worker: 4, status: 'accepted', createdAgo: 25, dueIn: 160, priority: 'normal', title: 'Ревизия подшипников насоса НП-1' },
    { id: 'live-007', equipmentId: 'eq-weigher-1', faultId: 'fault-calibration', worker: 5, status: 'ai_review', createdAgo: 180, dueIn: 60, priority: 'planned', type: 'planned', title: 'Поверка конвейерных весов ВК-1' },
    { id: 'live-008', equipmentId: 'eq-hydraulic-1', faultId: 'fault-hydraulic', worker: 6, status: 'rework', createdAgo: 240, dueIn: -60, priority: 'high', title: 'Устранить утечку масла на ГС-12', comment: 'ИИ вернул отчёт: нет фотографии после ремонта; расход масла 36 л требует пояснения. Учебный сценарий.' },
    { id: 'live-009', equipmentId: 'eq-cabinet-2', faultId: 'fault-drive', worker: 7, status: 'issued', createdAgo: 4, dueIn: 90, priority: 'emergency', title: 'Ошибка привода ПЧ-2 при запуске' },
    { id: 'live-010', equipmentId: 'eq-crane-1', faultId: 'fault-weld', worker: 8, status: 'issued', createdAgo: 12, dueIn: 240, priority: 'normal', title: 'Восстановить ограждение площадки КБ-5' },
    { id: 'live-011', equipmentId: 'eq-compressor-1', faultId: 'fault-air-filter', worker: 9, status: 'ai_review', createdAgo: 140, dueIn: 30, priority: 'planned', type: 'planned', title: 'Заменить воздушный фильтр КВ-10' },
    { id: 'live-012', equipmentId: 'eq-separator-1', faultId: 'fault-sensor', worker: 10, status: 'in_progress', createdAgo: 55, dueIn: 70, priority: 'normal', title: 'Настроить датчик сепаратора СМ-1' },
    { id: 'live-013', equipmentId: 'eq-screen-1', faultId: 'fault-screen', worker: 11, status: 'queued', createdAgo: 45, dueIn: 210, priority: 'normal', title: 'Заменить ситовую поверхность ГИС-52' },
    { id: 'live-014', equipmentId: 'eq-crane-2', faultId: 'fault-limit', worker: 12, status: 'rejected', createdAgo: 35, dueIn: 150, priority: 'high', title: 'Проверить концевой выключатель МК-10', comment: 'Нет действующего допуска к работам на высоте. Мастеру необходимо переназначить наряд. Учебный сценарий.' },
  ];

  for (const row of liveRows) {
    const assigneeId = `usr-worker-${row.worker}`;
    const created = anchor - row.createdAgo * MINUTE;
    const started = created + 15 * MINUTE;
    const order = makeOrder({ ...row, assigneeId, created, due: anchor + row.dueIn * MINUTE, type: row.type ?? 'unplanned' });
    // The current shift is owned by the demo master regardless of archive assignment.
    order.masterId = 'usr-master-1';
    order.events[0].actorId = 'usr-master-1';
    order.events[0].actorName = userById['usr-master-1'].name;
    if (row.status === 'queued' || row.status === 'rejected') {
      addEvent(order, assigneeId, 'transition', created + 3 * MINUTE, 'issued', row.status, row.status === 'queued' ? 'Поставлен в очередь после текущих работ.' : row.comment);
    } else if (row.status !== 'issued') {
      addEvent(order, assigneeId, 'transition', created + 3 * MINUTE, 'issued', 'accepted', 'Наряд принят.');
      if (row.status !== 'accepted') {
        order.startedAt = iso(started);
        addEvent(order, assigneeId, 'transition', started, 'accepted', 'in_progress', 'Начато исполнение.');
      }
      if (row.status === 'paused') addEvent(order, assigneeId, 'transition', anchor - 75 * MINUTE, 'in_progress', 'paused', row.comment);
      if (row.status === 'ai_review' || row.status === 'rework') {
        const completed = anchor - (row.status === 'rework' ? 40 : 12) * MINUTE;
        order.completedAt = iso(completed);
        order.completion = {
          works: worksByFault[row.faultId], faultId: row.faultId,
          materials: faultMaterials[row.faultId].map(([materialId, quantity]) => ({
            materialId, quantity: row.status === 'rework' && materialId === 'mat-oil-hydraulic' ? 36 : quantity,
          })),
          comment: row.status === 'rework' ? 'Долито 36 л масла. Фото результата пока не приложено. Учебный сценарий.' : 'Учебный отчёт о плановом обслуживании. Результат контрольной проверки описан в выполненных работах.',
          submittedAt: iso(completed),
        };
        addEvent(order, assigneeId, 'completed', completed, 'in_progress', 'completed', 'Работы исполнены, отчёт отправлен на проверку.');
        addEvent(order, 'system-ai', 'ai_review', completed + MINUTE, 'completed', 'ai_review', 'Проверка полноты, сроков и расхода ТМЦ.');
        order.assessment = makeAssessment(order, completed, row.status === 'rework' ? 2 : 5, row.status === 'rework', false, false);
        if (row.status === 'rework') {
          order.assessment.verdict = 'rework';
          order.assessment.confidence = 0.96;
          order.assessment.summary = 'Требуется доработка: отсутствует обязательное фото результата внепланового ремонта. Расход масла 36 л при справочной норме 12 л требует объяснения. Визуальная модель не использовалась.';
          order.assessment.checks = order.assessment.checks.map((check) => check.label === 'Фотоподтверждение' ? { label: check.label, status: 'fail', detail: 'Фото «после» обязательно для внеплановой работы, но не приложено.' } : check);
          order.assessment.improvements = ['Приложить актуальное фото результата ремонта.', 'Обосновать расход 36 л масла и указать причину повторной утечки.'];
          addEvent(order, 'system-ai', 'assessment', completed + 2 * MINUTE, 'ai_review', 'rework', order.assessment.summary);
        } else addEvent(order, 'system-ai', 'assessment', completed + 2 * MINUTE, undefined, undefined, 'Проверка завершена. Ожидается подтверждение мастера.');
      }
    }
    order.status = row.status;
    order.version = order.events.length;
    orders.push(order);
  }

  // Assert catalog references while constructing the fixture, so startup never silently imports broken data.
  for (const order of orders) {
    if (!equipmentById[order.equipmentId] || !userById[order.assigneeId] || !faultById[order.faultId]) throw new Error(`Invalid seed reference: ${order.id}`);
    for (const item of order.completion?.materials ?? []) if (!materialById[item.materialId]) throw new Error(`Invalid seed material: ${item.materialId}`);
  }
  orders.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { users, sites, equipment, brigades, faults, materials, orders };
}

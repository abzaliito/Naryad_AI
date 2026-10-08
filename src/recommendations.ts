import type { Catalogs, Fault, Order } from './types';
import { calculateRatings, getWorkerWorkloads } from './domain.ts';

// This is an explainable catalogue suggestion. The master confirms the code and norm.
export function suggestFault(description: string, faults: Fault[]): Fault | undefined {
  const text = description.toLocaleLowerCase('ru');
  const keywords: [RegExp, RegExp][] = [
    [/подшип|мойынтірек/, /подшип/], [/теч|утеч|гермет|ағып|ағу/, /теч|утеч|гермет/],
    [/контактор|контакт.*подгор/, /контактор/], [/изоляц|оқшаула/, /изоляц/],
    [/вибрац|діріл/, /вибрац/], [/лента|ленту|таспа/, /лент/], [/сито|ситов|елек/, /сит/],
    [/давлен|қысым/, /давлен/], [/датчик|сигнал|сенсор/, /датчик/],
    [/фильтр|сүзгі/, /фильтр/], [/муфт|соос/, /муфт/], [/смаз|майлау/, /смаз/],
    [/масл|май/, /масл/], [/креплен|болт|бекіт/, /креп|болт/],
    [/двигател|мотор|қозғалтқыш/, /двигател/], [/планов|осмотр|обслужив|жоспарлы|тексер/, /осмотр|обслужив/],
  ];
  for (const [trigger, match] of keywords) if (trigger.test(text)) {
    const fault = faults.find(value => match.test(value.name.toLocaleLowerCase('ru')));
    if (fault) return fault;
  }
  const terms = text.match(/[а-яёәіңғүұқөһ]{5,}/g) || [];
  return faults.map(fault => ({ fault, score: terms.filter(term => fault.name.toLocaleLowerCase('ru').includes(term.slice(0, 5))).length }))
    .filter(item => item.score >= 2).sort((a, b) => b.score - a.score)[0]?.fault;
}

export function recommendWorkers(orders: Order[], catalogs: Catalogs, equipmentId: string, specialty?: string) {
  const equipmentType = catalogs.equipment.find(item => item.id === equipmentId)?.type;
  const ids = new Set(catalogs.equipment.filter(item => item.type === equipmentType).map(item => item.id));
  const ratings = calculateRatings(orders.filter(order => ids.has(order.equipmentId)), catalogs.users);
  return getWorkerWorkloads(catalogs.users, orders).filter(item => item.user.onShift)
    .map(item => ({ ...item, rating: ratings.find(rating => rating.userId === item.user.id), specialtyMatch: Boolean(specialty && item.user.specialty === specialty), equipmentType }))
    .sort((a, b) => Number(b.specialtyMatch) - Number(a.specialtyMatch)
      || Number(b.status === 'free') - Number(a.status === 'free')
      || (b.rating?.evaluated ? b.rating.score : -1) - (a.rating?.evaluated ? a.rating.score : -1)
      || a.queueCount - b.queueCount || a.user.name.localeCompare(b.user.name, 'ru'));
}

import { useLocale } from './i18n';
import './language-switch.css';

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return <div className={`language-switch ${className}`} role="group" aria-label={t('Язык интерфейса')}>
    <button type="button" lang="ru" aria-label="Русский" aria-pressed={locale === 'ru'} onClick={() => setLocale('ru')}>RU</button>
    <button type="button" lang="kk" aria-label="Қазақша" aria-pressed={locale === 'kk'} onClick={() => setLocale('kk')}>ҚАЗ</button>
  </div>;
}

import { cn } from '../../utils';
import { t } from '@extension/i18n';
import { formatPrice, PRODUCTS } from '@extension/shared';
import type { FreeQuota, SubscriptionSummary } from '@extension/shared';

const creditProducts = Object.values(PRODUCTS).filter(product => product.kind === 'credits');
const proMonthly = PRODUCTS.pro_monthly;
const proYearly = PRODUCTS.pro_yearly;

const IconClose = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export type PaywallDialogProps = {
  open: boolean;
  isLight: boolean;
  free?: FreeQuota | null;
  credits?: number | null;
  subscription?: SubscriptionSummary;
  busyProduct?: string | null;
  error?: string | null;
  onClose: () => void;
  onPurchase: (productKey: string) => void;
  onRestore: () => void;
  onManage: () => void;
};

/**
 * Shared 402 paywall. It is purely presentational: the hosting page decides
 * how checkout is opened and how entitlement is refreshed afterwards.
 */
export const PaywallDialog = ({
  open,
  isLight,
  free,
  credits,
  subscription,
  busyProduct,
  error,
  onClose,
  onPurchase,
  onRestore,
  onManage,
}: PaywallDialogProps) => {
  if (!open) return null;

  const cardCls = cn(
    'relative w-full max-w-md rounded-2xl border p-5 shadow-2xl',
    isLight ? 'border-gray-200 bg-white text-gray-900' : 'border-white/[0.08] bg-[#14161d] text-gray-100',
  );
  const sub = isLight ? 'text-gray-500' : 'text-gray-400';
  const surface = isLight ? 'border-gray-200 bg-gray-50' : 'border-white/[0.06] bg-white/[0.03]';
  const buttonCls = cn(
    'rounded-xl border px-3 py-2.5 text-sm font-medium transition',
    isLight
      ? 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
      : 'border-white/10 hover:border-blue-400/40 hover:bg-blue-500/10',
  );
  const primaryCls =
    'rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60';
  const isPro = subscription?.status === 'active' || subscription?.status === 'trialing';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={t('paywallClose')}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div role="dialog" aria-modal="true" aria-label={t('paywallTitle')} className={cardCls}>
        <button
          type="button"
          aria-label={t('paywallClose')}
          onClick={onClose}
          className={cn(
            'absolute right-3 top-3 rounded-lg p-1.5 transition',
            sub,
            isLight ? 'hover:bg-gray-100' : 'hover:bg-white/10',
          )}>
          <IconClose />
        </button>

        <p className="text-lg font-semibold">{t('paywallTitle')}</p>
        <p className={cn('mt-1 text-sm', sub)}>{t('paywallBody')}</p>
        {free ? (
          <p className={cn('mt-2 text-xs font-medium', sub)}>
            {free.used}/{free.limit} {t('paywallFreeUsed')}
          </p>
        ) : null}
        {typeof credits === 'number' && credits > 0 ? (
          <p className={cn('mt-1 text-xs font-medium', sub)}>{credits} credits available</p>
        ) : null}

        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide">{t('paywallCreditsTitle')}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {creditProducts.map(product => (
              <button
                key={product.key}
                type="button"
                disabled={busyProduct !== null && busyProduct !== undefined}
                onClick={() => onPurchase(product.key)}
                className={buttonCls}>
                <span className="block text-sm font-semibold">
                  {product.credits} {t('paywallCreditsUnit')}
                </span>
                <span className={cn('block text-xs', sub)}>{formatPrice(product)}</span>
                {busyProduct === product.key ? (
                  <span className="mt-1 block text-[11px] text-blue-500">{t('paywallWaiting')}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className={cn('mt-4 rounded-xl border p-3', surface)}>
          <p className="text-sm font-semibold">{t('paywallProTitle')}</p>
          <p className={cn('mt-0.5 text-xs', sub)}>{t('paywallProBody')}</p>
          {isPro ? (
            <button type="button" onClick={onManage} className={cn('mt-2 w-full', primaryCls)}>
              {t('paywallManage')}
            </button>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busyProduct !== null && busyProduct !== undefined}
                onClick={() => onPurchase(proMonthly.key)}
                className={primaryCls}>
                {t('paywallProMonthly')} · {formatPrice(proMonthly)}
              </button>
              <button
                type="button"
                disabled={busyProduct !== null && busyProduct !== undefined}
                onClick={() => onPurchase(proYearly.key)}
                className={buttonCls}>
                {t('paywallProYearly')} · {formatPrice(proYearly)}
              </button>
            </div>
          )}
          {busyProduct === proMonthly.key || busyProduct === proYearly.key ? (
            <p className="mt-2 text-[11px] text-blue-500">{t('paywallWaiting')}</p>
          ) : null}
        </div>

        {error ? <p className="mt-3 text-xs text-rose-500">{error}</p> : null}

        <div className={cn('mt-4 flex items-center justify-between text-xs', sub)}>
          <button type="button" onClick={onRestore} className="underline underline-offset-2 hover:text-blue-500">
            {t('paywallRestore')}
          </button>
          <span className="flex items-center gap-3">
            <a
              href="https://uu0uu.com/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-blue-500">
              {t('paywallPrivacy')}
            </a>
            <a
              href="https://uu0uu.com/terms"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-blue-500">
              {t('paywallTerms')}
            </a>
            <a
              href="https://uu0uu.com/refund"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-blue-500">
              {t('paywallRefund')}
            </a>
          </span>
        </div>
      </div>
    </div>
  );
};

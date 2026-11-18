import { t } from '@extension/i18n';
import { LICENSE_MESSAGE, PRODUCTS, formatPrice } from '@extension/shared';
import { cn } from '@extension/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LicenseActivateResponse,
  LicenseCheckoutResponse,
  LicensePortalResponse,
  LicenseStatusPayload,
  LicenseStatusResponse,
  Plan,
  Product,
  SubscriptionStatus,
} from '@extension/shared';

const creditProducts = Object.values(PRODUCTS).filter(product => product.kind === 'credits');
const proProducts = Object.values(PRODUCTS).filter(product => product.kind === 'subscription');

const sendMessage = <T,>(message: unknown): Promise<T | undefined> =>
  chrome.runtime.sendMessage(message) as Promise<T | undefined>;

const subscriptionLabel = (status: SubscriptionStatus): string => {
  switch (status) {
    case 'active':
      return t('licenseStatusActive');
    case 'trialing':
      return t('licenseStatusTrialing');
    case 'scheduled_cancel':
      return t('licenseStatusScheduledCancel');
    case 'canceled':
      return t('licenseStatusCanceled');
    case 'expired':
      return t('licenseStatusExpired');
    case 'paused':
      return t('licenseStatusPaused');
    default:
      return t('licenseStatusNone');
  }
};

const ProductRow = ({
  product,
  busy,
  isLight,
  onBuy,
}: {
  product: Product;
  busy: boolean;
  isLight: boolean;
  onBuy: (key: string) => void;
}) => (
  <div
    className={cn(
      'flex items-center justify-between rounded-xl border px-3 py-2.5',
      isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-white/[0.02]',
    )}>
    <div>
      <p className="text-sm font-medium">
        {product.kind === 'credits'
          ? `${product.credits} credits`
          : product.key === 'pro_monthly'
            ? t('licenseProMonthly')
            : t('licenseProYearly')}
      </p>
      <p className={cn('text-xs', isLight ? 'text-gray-400' : 'text-gray-500')}>
        {formatPrice(product)}
        {product.interval === 'every-month' ? ' / month' : product.interval === 'every-year' ? ' / year' : ''}
      </p>
    </div>
    <button
      type="button"
      disabled={busy}
      onClick={() => onBuy(product.key)}
      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60">
      {t('licenseBuy')}
    </button>
  </div>
);

export const LicensePanel = ({ isLight }: { isLight: boolean }) => {
  const [status, setStatus] = useState<LicenseStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState('');
  const [pollUntil, setPollUntil] = useState(0);
  const pollBaseline = useRef<{ credits: number; plan: Plan } | null>(null);

  const cardCls = cn(
    'rounded-2xl border',
    isLight ? 'border-gray-200 bg-white shadow-sm' : 'border-white/[0.06] bg-white/[0.02]',
  );
  const divider = cn('border-t', isLight ? 'border-gray-100' : 'border-white/[0.04]');
  const label = isLight ? 'text-gray-800' : 'text-gray-100';
  const sub = isLight ? 'text-gray-400' : 'text-gray-500';
  const inputCls = cn(
    'w-full rounded-lg border px-3 py-2 text-sm outline-none transition',
    isLight
      ? 'border-gray-200 bg-white focus:border-blue-400'
      : 'border-white/10 bg-white/[0.03] text-gray-100 focus:border-blue-400/60',
  );

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy('refresh');
    try {
      const response = await sendMessage<LicenseStatusResponse>({ type: LICENSE_MESSAGE.REFRESH });
      if (response?.ok) {
        setStatus(response.status);
        setError(null);
      } else {
        setError(response?.error ?? t('licenseActionFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!silent) setBusy(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await sendMessage<LicenseStatusResponse>({ type: LICENSE_MESSAGE.STATUS });
        if (!cancelled && response?.ok) setStatus(response.status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll entitlement every 3s for at most 2 minutes after checkout. The
  // background alarm keeps syncing afterwards, so closing options is safe.
  useEffect(() => {
    if (pollUntil === 0) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        if (Date.now() >= pollUntil) {
          clearInterval(timer);
          setPollUntil(0);
          setNotice(null);
          return;
        }
        const response = await sendMessage<LicenseStatusResponse>({ type: LICENSE_MESSAGE.REFRESH });
        if (cancelled || !response?.ok) return;
        setStatus(response.status);
        const baseline = pollBaseline.current;
        if (baseline && (response.status.credits !== baseline.credits || response.status.plan !== baseline.plan)) {
          clearInterval(timer);
          setPollUntil(0);
          setNotice(t('licensePurchaseDetected'));
        }
      })();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollUntil]);

  const purchase = async (productKey: string) => {
    setBusy(productKey);
    setError(null);
    setNotice(null);
    try {
      const response = await sendMessage<LicenseCheckoutResponse>({
        type: LICENSE_MESSAGE.CHECKOUT,
        payload: { productKey },
      });
      if (response?.ok) {
        pollBaseline.current = { credits: status?.credits ?? 0, plan: status?.plan ?? 'free' };
        setPollUntil(Date.now() + 120_000);
        setNotice(t('licenseWaitingPayment'));
      } else {
        setError(response?.error ?? t('licenseActionFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    const key = licenseKey.trim();
    if (!key) return;
    setBusy('activate');
    setError(null);
    setNotice(null);
    try {
      const response = await sendMessage<LicenseActivateResponse>({
        type: LICENSE_MESSAGE.ACTIVATE,
        payload: { licenseKey: key },
      });
      if (response?.ok) {
        setStatus(response.status);
        setLicenseKey('');
        setNotice(t('licenseActivated'));
      } else {
        setError(response?.error ?? t('licenseActionFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const manage = async () => {
    setBusy('portal');
    setError(null);
    try {
      const response = await sendMessage<LicensePortalResponse>({ type: LICENSE_MESSAGE.PORTAL });
      if (!response?.ok) setError(response?.error ?? t('licenseActionFailed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const free = status?.free;
  const freeUsed = free ? Math.min(free.used, free.limit) : 0;
  const freePercent = free && free.limit > 0 ? Math.min(100, Math.round((freeUsed / free.limit) * 100)) : 0;
  const isPro = status?.plan === 'pro';

  return (
    <div className="space-y-6">
      <div>
        <h2 className={cn('text-lg font-semibold', label)}>{t('licenseTitle')}</h2>
        <p className={cn('mt-1 text-sm', sub)}>{t('licenseSubtitle')}</p>
      </div>

      {/* Status card */}
      <div className={cn(cardCls, 'px-5 py-4')}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">
              {isPro ? t('licensePlanPro') : t('licensePlanFree')}
              {status?.offline ? <span className="ml-2 text-xs text-amber-500">{t('licenseOffline')}</span> : null}
            </p>
            <p className={cn('mt-1 text-xs', sub)}>
              {t('licenseDevice')}: {status?.deviceId ? `${status.deviceId.slice(0, 12)}…` : '—'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy === 'refresh'}
            onClick={() => void refresh()}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              isLight ? 'border-gray-200 hover:bg-gray-50' : 'border-white/10 hover:bg-white/[0.04]',
            )}>
            {busy === 'refresh' ? t('licenseRefreshing') : t('licenseRefresh')}
          </button>
        </div>

        <div className={cn('mt-4 grid gap-3 sm:grid-cols-3')}>
          <div className={cn('rounded-xl border px-3 py-2.5', isLight ? 'border-gray-200' : 'border-white/[0.06]')}>
            <p className={cn('text-[11px] uppercase tracking-wide', sub)}>{t('licenseFreeToday')}</p>
            <p className="mt-1 text-sm font-semibold">{free ? `${freeUsed}/${free.limit}` : '—'}</p>
            <div className={cn('mt-2 h-1.5 overflow-hidden rounded-full', isLight ? 'bg-gray-100' : 'bg-white/[0.06]')}>
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${freePercent}%` }} />
            </div>
          </div>
          <div className={cn('rounded-xl border px-3 py-2.5', isLight ? 'border-gray-200' : 'border-white/[0.06]')}>
            <p className={cn('text-[11px] uppercase tracking-wide', sub)}>{t('licenseCredits')}</p>
            <p className="mt-1 text-sm font-semibold">{status?.credits ?? 0}</p>
          </div>
          <div className={cn('rounded-xl border px-3 py-2.5', isLight ? 'border-gray-200' : 'border-white/[0.06]')}>
            <p className={cn('text-[11px] uppercase tracking-wide', sub)}>{t('licenseSubscription')}</p>
            <p className="mt-1 text-sm font-semibold">
              {status?.subscription ? subscriptionLabel(status.subscription.status) : t('licenseStatusNone')}
            </p>
          </div>
        </div>

        {status && status.pendingReports > 0 ? (
          <p className={cn('mt-3 text-xs', sub)}>
            {status.pendingReports} {t('licensePendingReports')}
          </p>
        ) : null}
        {status?.subscription &&
        (status.subscription.status === 'active' || status.subscription.status === 'trialing') ? (
          <button
            type="button"
            disabled={busy === 'portal'}
            onClick={() => void manage()}
            className={cn(
              'mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              isLight ? 'border-gray-200 hover:bg-gray-50' : 'border-white/10 hover:bg-white/[0.04]',
            )}>
            {t('licenseManage')}
          </button>
        ) : null}
      </div>

      {/* Purchase */}
      <div className={cardCls}>
        <div className="px-5 py-4">
          <p className="text-sm font-medium">{t('licenseBuyCreditsTitle')}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {creditProducts.map(product => (
              <ProductRow
                key={product.key}
                product={product}
                busy={busy !== null}
                isLight={isLight}
                onBuy={productKey => void purchase(productKey)}
              />
            ))}
          </div>
        </div>
        <div className={divider} />
        <div className="px-5 py-4">
          <p className="text-sm font-medium">{t('licenseBuyProTitle')}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {proProducts.map(product => (
              <ProductRow
                key={product.key}
                product={product}
                busy={busy !== null}
                isLight={isLight}
                onBuy={productKey => void purchase(productKey)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Restore */}
      <div className={cardCls}>
        <div className="px-5 py-4">
          <p className="text-sm font-medium">{t('licenseRestoreTitle')}</p>
          <p className={cn('mt-1 text-xs', sub)}>{t('licenseRestoreBody')}</p>
          <div className="mt-3 flex gap-2">
            <input
              value={licenseKey}
              onChange={event => setLicenseKey(event.target.value)}
              placeholder={t('licenseKeyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className={inputCls}
            />
            <button
              type="button"
              disabled={busy !== null || licenseKey.trim().length === 0}
              onClick={() => void activate()}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60">
              {busy === 'activate' ? t('licenseActivating') : t('licenseActivate')}
            </button>
          </div>
          <p className={cn('mt-2 text-xs', sub)}>{t('licenseRestoreHint')}</p>
        </div>
      </div>

      {loading ? <p className={cn('text-xs', sub)}>{t('licenseLoading')}</p> : null}
      {error ? <p className="text-xs text-rose-500">{error}</p> : null}
      {notice ? <p className="text-xs text-blue-500">{notice}</p> : null}

      <div className={cn('flex items-center gap-4 text-xs', sub)}>
        <a href="https://uu0uu.com/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {t('licensePrivacy')}
        </a>
        <a href="https://uu0uu.com/terms" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {t('licenseTerms')}
        </a>
        <a href="https://uu0uu.com/refund" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {t('licenseRefund')}
        </a>
      </div>
    </div>
  );
};

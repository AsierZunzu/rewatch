import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { ScreenTitle, Spinner } from '../components/ui'

type FeedToken = { token: string | null }

const feedUrl = (token: string) => `${window.location.origin}/api/calendar/${token}.ics`

export default function CalendarFeed() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [confirmingRotate, setConfirmingRotate] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data, isPending } = useQuery({
    queryKey: ['calendar-feed'],
    queryFn: () => api.get<FeedToken>('/api/calendar-feed'),
  })

  const mutate = async (fn: () => Promise<FeedToken>) => {
    setBusy(true)
    try {
      qc.setQueryData(['calendar-feed'], await fn())
      setConfirmingRotate(false)
      setCopied(false)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!data?.token) return
    await navigator.clipboard.writeText(feedUrl(data.token))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isPending) return <Spinner />

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTitle title={t('calendarFeed.title')} />
      <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-5 lg:max-w-2xl lg:px-8">
        <div className="bg-card rounded-[18px] border border-line p-4">
          <div className="text-muted text-[13px] leading-normal">{t('calendarFeed.intro')}</div>
        </div>

        {data?.token ? (
          <>
            <div className="bg-card rounded-[18px] border border-line p-4">
              <div className="text-[13px] font-extrabold">{t('calendarFeed.urlTitle')}</div>
              <div className="bg-track text-muted mt-2 rounded-[12px] p-2.5 text-[11.5px] break-all">
                {feedUrl(data.token)}
              </div>
              <button
                type="button"
                onClick={copy}
                className="bg-accent text-ink mt-2.5 w-full rounded-[12px] py-2.5 text-[13px] font-extrabold"
              >
                {copied ? t('calendarFeed.copied') : t('calendarFeed.copy')}
              </button>
              <div className="text-dim mt-2 text-[11.5px] leading-normal">{t('calendarFeed.secretHint')}</div>
            </div>

            <div className="bg-card rounded-[18px] border border-line p-4">
              <div className="text-[13px] font-extrabold">{t('calendarFeed.rotateTitle')}</div>
              <div className="text-muted mt-1 text-[12.5px] leading-normal">{t('calendarFeed.rotateText')}</div>
              {confirmingRotate ? (
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void mutate(() => api.post<FeedToken>('/api/calendar-feed'))}
                    className="bg-danger text-ink flex-1 rounded-[12px] py-2.5 text-[13px] font-extrabold disabled:opacity-60"
                  >
                    {t('calendarFeed.rotateConfirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRotate(false)}
                    className="text-muted flex-1 rounded-[12px] border border-line py-2.5 text-[13px] font-bold"
                  >
                    {t('calendarFeed.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRotate(true)}
                  className="text-danger mt-2.5 w-full rounded-[12px] border border-line py-2.5 text-[13px] font-extrabold"
                >
                  {t('calendarFeed.rotate')}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void mutate(() => api.delete<FeedToken>('/api/calendar-feed'))}
                className="text-muted mt-2 w-full py-2 text-center text-[12.5px] font-bold disabled:opacity-60"
              >
                {t('calendarFeed.disable')}
              </button>
            </div>
          </>
        ) : (
          <div className="bg-card rounded-[18px] border border-line p-4">
            <div className="text-[13px] font-extrabold">{t('calendarFeed.offTitle')}</div>
            <div className="text-muted mt-1 text-[12.5px] leading-normal">{t('calendarFeed.offText')}</div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(() => api.post<FeedToken>('/api/calendar-feed'))}
              className="bg-accent text-ink mt-2.5 w-full rounded-[12px] py-2.5 text-[13px] font-extrabold disabled:opacity-60"
            >
              {t('calendarFeed.enable')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

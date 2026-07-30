// File import card: dropzone + job progress + final report.
// Takes a TV Time GDPR zip or a Rewatch export JSON — routed by extension.
// Lives on the import screen; re-adopts the user's latest job on mount so
// navigating away during an import doesn't lose the progress display.
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { ApiError, api } from '../api/client'
import { useImportJob, usePending } from '../api/hooks'
import type { ImportJob } from '../api/types'

const DAY_MS = 24 * 60 * 60 * 1000

export default function ImportCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const { data: latest } = useQuery({
    queryKey: ['import-job-latest'],
    queryFn: () => api.get<{ job: ImportJob | null }>('/api/import/jobs/latest'),
    staleTime: 0,
  })
  // Adopt an in-flight job, or a failure recent enough to still matter.
  const adopted =
    latest?.job &&
    (latest.job.status === 'RUNNING' ||
      (latest.job.status === 'FAILED' && Date.now() - new Date(latest.job.updatedAt).getTime() < DAY_MS))
      ? latest.job.id
      : null
  const effectiveJobId = jobId ?? adopted
  const { data: job } = useImportJob(effectiveJobId)
  const { data: pending } = usePending()

  const upload = async (file: File) => {
    setFileName(file.name)
    setUploadError(null)
    const form = new FormData()
    form.append('file', file)
    // A .json is our own export; anything else is assumed to be the TV Time zip
    // (whose endpoint validates it anyway).
    const endpoint = file.name.toLowerCase().endsWith('.json') ? '/api/import/rewatch' : '/api/import/tvtime'
    try {
      const { jobId } = await api.post<{ jobId: number }>(endpoint, form)
      setJobId(jobId)
    } catch (err) {
      // The Rewatch endpoint validates before queueing, so bad files fail here
      // rather than surfacing as a failed job.
      const code = err instanceof ApiError ? err.code : 'upload_failed'
      setUploadError(t(`profile.importError.${code}`, { defaultValue: t('profile.importError.upload_failed') }))
    }
  }

  // Finished report
  if (job?.status === 'DONE' && job.report) {
    const r = job.report
    const rows = [
      { icon: '✓', ok: true, node: <Trans i18nKey="profile.importEpisodes" values={{ count: r.episodes.imported.toLocaleString(), shows: r.shows.mapped }} components={{ b: <b /> }} /> },
      { icon: '✓', ok: true, node: <Trans i18nKey="profile.importMovies" values={{ count: r.movies.autoMatched + r.movies.watchlist }} components={{ b: <b /> }} /> },
      ...(r.movies.pending > 0
        ? [{ icon: '!', ok: false, node: <Trans i18nKey="profile.importPending" values={{ count: r.movies.pending }} components={{ b: <b /> }} /> }]
        : []),
    ]
    return (
      <div className="bg-card rounded-[18px] border border-line p-4">
        <div className="flex flex-col items-center gap-2.5 py-3.5 text-center">
          <div className="bg-accent text-ink flex h-18 w-18 items-center justify-center rounded-full text-[32px] font-extrabold shadow-[0_10px_30px_rgba(255,201,75,.3)]">
            ✓
          </div>
          <div className="text-xl font-extrabold">{t('profile.importDone')}</div>
          <div className="text-muted text-[13px] font-semibold">{fileName}</div>
        </div>
        <div className="bg-surface mt-2 overflow-hidden rounded-[14px]">
          {rows.map((row, i) => (
            <div key={i} className={`flex items-center gap-3 px-4 py-3.75 ${i > 0 ? 'border-t border-white/5' : ''}`}>
              <span
                className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] font-extrabold ${
                  row.ok ? 'bg-green/18 text-green' : 'bg-accent/16 text-accent'
                }`}
              >
                {row.icon}
              </span>
              <div className="flex-1 text-sm font-semibold [&_b]:font-extrabold">{row.node}</div>
            </div>
          ))}
        </div>
        {r.movies.pending > 0 && (
          <Link
            viewTransition
            to="/resolve"
            className="bg-accent text-ink mt-3.5 block rounded-[15px] py-3.75 text-center text-[15px] font-extrabold"
          >
            {t('profile.importResolve', { count: r.movies.pending })}
          </Link>
        )}
        <button type="button" onClick={() => setJobId(null)} className="text-muted mt-3 w-full text-center text-[13px] font-bold">
          {r.movies.pending > 0 ? t('profile.importLater') : t('profile.importClose')}
        </button>
      </div>
    )
  }

  // Import in progress
  if (job?.status === 'RUNNING' || (effectiveJobId !== null && !job)) {
    const p = job?.progress
    const phases: Record<string, string> = {
      shows: t('profile.phaseShows'),
      episodes: t('profile.phaseEpisodes'),
      movies: t('profile.phaseMovies'),
    }
    return (
      <div className="bg-card rounded-[18px] border border-line p-4">
        <div className="text-[14.5px] font-extrabold">{t('profile.importRunning')}</div>
        <div className="text-muted mt-1 text-[12.5px]">{fileName}</div>
        <div className="bg-track mt-4 h-1.5 overflow-hidden rounded">
          <div
            className="bg-accent h-full rounded transition-all duration-500"
            style={{ width: p ? `${(p.done / Math.max(1, p.total)) * 100}%` : '4%' }}
          />
        </div>
        <div className="text-dim mt-2 text-xs font-semibold">
          {p ? `${phases[p.phase] ?? p.phase} · ${p.done}/${p.total}` : t('profile.importAnalyzing')}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-[18px] border border-line p-4">
      {uploadError && <div className="text-danger mb-3 text-[13px] font-semibold">{uploadError}</div>}
      {!uploadError && job?.status === 'FAILED' && (
        <div className="text-danger mb-3 text-[13px] font-semibold">{t('profile.importFailed', { error: job.error })}</div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-[14.5px] font-extrabold">{t('profile.importTitle')}</span>
        <span className="bg-accent text-ink rounded-md px-1.75 py-0.5 text-[10px] font-extrabold tracking-wide">
          {t('profile.importFree')}
        </span>
      </div>
      <div className="text-muted mt-1.25 text-[12.5px] leading-normal">{t('profile.importText')}</div>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void upload(file)
        }}
        className={`mt-3 flex w-full flex-col items-center gap-2 rounded-[14px] border-[1.5px] border-dashed p-5.5 text-center ${
          dragOver ? 'border-accent bg-accent/5' : 'border-border2'
        }`}
      >
        <div className="bg-track text-accent flex h-10 w-10 items-center justify-center rounded-full text-[17px] font-extrabold">↑</div>
        <div className="text-[13px] font-bold">{t('profile.importDrop')}</div>
        <div className="text-dim text-[11px] font-semibold">{t('profile.importFormat')}</div>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".zip,.json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void upload(file)
          e.target.value = ''
        }}
      />
      {(pending?.length ?? 0) > 0 && (
        <Link viewTransition to="/resolve" className="text-accent mt-3 block text-center text-[13px] font-extrabold">
          {t('profile.importPendingLink', { count: pending!.length })}
        </Link>
      )}
      {void qc}
    </div>
  )
}

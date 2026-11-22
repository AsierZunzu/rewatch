import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Poster } from './Poster'
import StateMenu from './StateMenu'

describe('Poster', () => {
  it('shows the TMDB image when there is one', () => {
    render(<Poster path="/x.jpg" title="Dark" size="w185" />)
    expect(screen.getByRole('img', { name: 'Dark' })).toHaveAttribute('src', 'https://image.tmdb.org/t/p/w185/x.jpg')
  })

  it('falls back to a colored card with the initial and the title', () => {
    const { container } = render(<Poster path={null} title="The Wire" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('W')).toBeInTheDocument()
    expect(screen.getByText('The Wire')).toBeInTheDocument()
    expect((container.firstChild as HTMLElement).style.background).not.toBe('')
  })
})

describe('StateMenu', () => {
  const setup = () => {
    const onWatching = vi.fn()
    const onArchive = vi.fn()
    const onRemove = vi.fn()
    render(
      <StateMenu
        label="Watching"
        removeLabel="Remove"
        onRemove={onRemove}
        options={[
          { key: 'watching', label: 'Watching', active: true, onSelect: onWatching },
          { key: 'archived', label: 'Archived', active: false, onSelect: onArchive },
        ]}
      />,
    )
    return { onWatching, onArchive, onRemove, user: userEvent.setup() }
  }

  it('is closed until the button is pressed', async () => {
    const { user } = setup()
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Watching/ }))
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  it('selects an inactive state and closes', async () => {
    const { user, onArchive } = setup()
    await user.click(screen.getByRole('button', { name: /Watching/ }))
    await user.click(screen.getByRole('button', { name: 'Archived' }))
    expect(onArchive).toHaveBeenCalledOnce()
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
  })

  it('does not re-select the active state', async () => {
    const { user, onWatching } = setup()
    await user.click(screen.getByRole('button', { name: /Watching/ }))
    await user.click(screen.getByRole('button', { name: /^Watching\s*✓$/ }))
    expect(onWatching).not.toHaveBeenCalled()
  })

  it('removes', async () => {
    const { user, onRemove } = setup()
    await user.click(screen.getByRole('button', { name: /Watching/ }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

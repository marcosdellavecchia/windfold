/**
 * Sound on/off. Deliberately the quietest thing on screen — rule 7 says no UI to
 * learn, so it sits where a browser control would and never asks to be noticed.
 *
 * `data-ui` keeps the global pointer handler from reading a click here as a launch.
 */
export function AudioToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      className="audioToggle"
      data-ui
      onClick={onToggle}
      aria-label={muted ? 'Turn music on' : 'Turn music off'}
      title={muted ? 'Music off' : 'Music on'}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M2 6.2h2.2L7.4 3.4v9.2L4.2 9.8H2z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.6"
          strokeLinejoin="round"
        />
        {muted ? (
          <path
            d="M10 6l4 4M14 6l-4 4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            fill="none"
          />
        ) : (
          <>
            <path d="M9.9 5.6a3.4 3.4 0 0 1 0 4.8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
            <path d="M12 3.9a6 6 0 0 1 0 8.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  )
}

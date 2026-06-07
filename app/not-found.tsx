const styles = {
  main: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    textAlign: 'center' as const,
    color: '#101218',
    background:
      'radial-gradient(circle at 20% 20%, rgba(0,169,143,.16), transparent 32%), radial-gradient(circle at 80% 10%, rgba(19,138,223,.14), transparent 34%), #ffffff',
  },
  code: {
    margin: 0,
    color: '#00a98f',
    fontSize: '0.78rem',
    fontWeight: 700,
    letterSpacing: '0.2em',
    textTransform: 'uppercase' as const,
  },
  title: {
    margin: '12px 0 0',
    fontSize: 'clamp(2rem, 5vw, 3.5rem)',
    lineHeight: 1,
  },
  body: {
    margin: '10px 0 0',
    color: '#5e6675',
  },
};

export default function NotFoundPage() {
  return (
    <main style={styles.main}>
      <div>
        <p style={styles.code}>404</p>
        <h1 style={styles.title}>Page not found</h1>
        <p style={styles.body}>The page you are looking for does not exist.</p>
      </div>
    </main>
  );
}

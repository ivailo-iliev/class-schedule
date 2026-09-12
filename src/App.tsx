import { useState } from 'react';

export default function App() {
  const [hasCredential] = useState(
    () => typeof window !== 'undefined' && window.location.hash.length > 1,
  );

  if (!hasCredential) {
    return (
      <main>
        <h1>Class Scheduler</h1>
        <p>Open your personal access link</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Class Scheduler</h1>
    </main>
  );
}

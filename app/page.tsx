'use client';
import dynamic from 'next/dynamic';

// La carte et le jeu utilisent WebGL : rendu uniquement côté navigateur.
const App = dynamic(() => import('@/components/App'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-anthracite-950 text-glacier-200/70 text-sm tracking-widest uppercase">
      Chargement du domaine…
    </div>
  ),
});

export default function Page() {
  return <App />;
}

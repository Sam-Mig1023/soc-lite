/**
 * SOC-Lite · Página 404.
 */
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

/** Ruta no encontrada dentro del layout autenticado. */
export function NotFound(): JSX.Element {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="soc-panel max-w-lg p-8 text-center">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-cyan-400">
          <Compass size={26} aria-hidden="true" />
        </span>
        <p className="font-mono text-3xl font-semibold text-slate-200">404</p>
        <h1 className="mt-2 text-lg font-semibold text-slate-100">Ruta no encontrada</h1>
        <p className="mt-2 text-sm text-slate-400">
          La dirección solicitada no corresponde a ninguna pantalla del panel. Verifica el enlace o vuelve al
          dashboard.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link to="/" className="soc-btn-primary">
            Volver al dashboard
          </Link>
          <Link to="/alerts" className="soc-btn-secondary">
            Ver alertas
          </Link>
        </div>
      </div>
    </div>
  );
}

export default NotFound;

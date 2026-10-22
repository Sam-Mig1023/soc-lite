/**
 * SOC-Lite · Página de acceso.
 * Formulario usuario/contraseña validado con React Hook Form + Zod.
 * Las credenciales de demostración (db/seed.sql) se muestran para facilitar la evaluación.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Loader2, LogIn, ShieldHalf, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { getErrorMessage } from '@/utils/errors';
import { cx } from '@/utils/format';

/** Esquema de validación del formulario de acceso. */
const loginSchema = z.object({
  username: z
    .string()
    .min(3, 'El usuario debe tener al menos 3 caracteres')
    .max(64, 'El usuario no puede superar 64 caracteres'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

/** Credenciales demo del seed (solo entorno de demostración). */
const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'Admin123!', role: 'Administrador' },
  { username: 'soc_manager', password: 'Manager123!', role: 'Jefe de SOC' },
  { username: 'analista1', password: 'Analyst123!', role: 'Analista SOC' },
  { username: 'auditor1', password: 'Audit123!', role: 'Auditor' },
  { username: 'visor1', password: 'Viewer123!', role: 'Consulta' },
] as const;

interface LocationState {
  from?: string;
}

/** Pantalla de inicio de sesión. */
export function Login(): JSX.Element {
  const { login, isAuthenticated, isBootstrapping } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
    mode: 'onBlur',
  });

  const from = (location.state as LocationState | null)?.from ?? '/';

  if (!isBootstrapping && isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  const onSubmit = async (values: LoginFormValues): Promise<void> => {
    setServerError(null);
    try {
      await login(values);
      navigate(from, { replace: true });
    } catch (error) {
      setServerError(getErrorMessage(error));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <div className="grid w-full max-w-5xl gap-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 shadow-panel lg:grid-cols-[1.05fr_1fr]">
        {/* Panel de marca */}
        <aside className="relative hidden flex-col justify-between border-r border-slate-800 bg-gradient-to-br from-slate-900 via-slate-950 to-cyan-950/40 p-8 lg:flex">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="rounded-lg border border-cyan-800/70 bg-cyan-950/60 p-2 text-cyan-400">
                <ShieldHalf size={24} aria-hidden="true" />
              </span>
              <div>
                <p className="text-lg font-semibold tracking-wide text-slate-100">SOC-Lite</p>
                <p className="text-[11px] uppercase tracking-widest text-slate-500">
                  Security Operations Center
                </p>
              </div>
            </div>

            <h1 className="mt-8 text-2xl font-semibold leading-snug text-slate-100">
              Triaje asistido por IA para tu centro de operaciones
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">
              Correlación de alertas Wazuh y OPNsense, veredicto automático del modelo, gestión de incidentes y
              trazabilidad completa de cada acción en la bitácora de auditoría.
            </p>

            <ul className="mt-6 space-y-2.5 text-sm text-slate-400">
              <li className="flex items-start gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                Reducción de ruido y tasa de falsos positivos medida en tiempo real.
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                RBAC por módulo y acción, con bitácora inmutable de cada evento.
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                Cumplimiento ISO/IEC 27001:2022 y NIST CSF 2.0.
              </li>
            </ul>
          </div>

          <p className="mt-8 text-[11px] text-slate-600">
            API: http://localhost:8000/api/v1 · Access token 30 min · Refresh token 8 h
          </p>
        </aside>

        {/* Formulario */}
        <section className="p-6 sm:p-8">
          <div className="mb-6 lg:hidden">
            <div className="flex items-center gap-2">
              <span className="rounded-lg border border-cyan-800/70 bg-cyan-950/60 p-1.5 text-cyan-400">
                <ShieldHalf size={20} aria-hidden="true" />
              </span>
              <span className="text-base font-semibold text-slate-100">SOC-Lite</span>
            </div>
          </div>

          <h2 className="text-xl font-semibold text-slate-100">Iniciar sesión</h2>
          <p className="mt-1 text-sm text-slate-400">
            Ingresa tus credenciales corporativas para acceder al panel de operaciones.
          </p>

          {serverError ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2.5 text-sm text-red-200"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{serverError}</span>
            </div>
          ) : null}

          <form className="mt-5 space-y-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
            <div>
              <label className="soc-label" htmlFor="username">
                Usuario
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                autoFocus
                className={cx('soc-input', errors.username && 'border-red-600 focus:border-red-500')}
                placeholder="admin"
                aria-invalid={Boolean(errors.username)}
                aria-describedby={errors.username ? 'username-error' : undefined}
                {...register('username')}
              />
              {errors.username ? (
                <p id="username-error" role="alert" className="mt-1 text-xs text-red-400">
                  {errors.username.message}
                </p>
              ) : null}
            </div>

            <div>
              <label className="soc-label" htmlFor="password">
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className={cx('soc-input pr-10', errors.password && 'border-red-600 focus:border-red-500')}
                  placeholder="••••••••"
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'password-error' : undefined}
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-500 hover:text-slate-300"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {errors.password ? (
                <p id="password-error" role="alert" className="mt-1 text-xs text-red-400">
                  {errors.password.message}
                </p>
              ) : null}
            </div>

            <button type="submit" className="soc-btn-primary w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                  Verificando credenciales…
                </>
              ) : (
                <>
                  <LogIn size={16} aria-hidden="true" />
                  Entrar al SOC
                </>
              )}
            </button>
          </form>

          {/* Credenciales de demostración */}
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Credenciales de demostración
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Datos de ejemplo de <span className="soc-code">db/seed.sql</span>. Cámbialos en producción.
            </p>
            <ul className="mt-3 space-y-1.5">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.username}>
                  <button
                    type="button"
                    onClick={() => {
                      setValue('username', account.username, { shouldValidate: true });
                      setValue('password', account.password, { shouldValidate: true });
                      setServerError(null);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-left text-xs transition-colors hover:border-cyan-800 hover:bg-slate-800/70"
                    aria-label={`Usar credenciales de ${account.role}`}
                  >
                    <span className="font-mono text-slate-200">
                      {account.username} / {account.password}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">{account.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

export default Login;

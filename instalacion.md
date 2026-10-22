# Guía de instalación de SOC-Lite en Windows

Esta guía explica cómo preparar una computadora nueva para ejecutar SOC-Lite con
Docker Desktop. Los comandos son para **PowerShell**. No hace falta instalar
Python, Node.js, PostgreSQL ni la aplicación Ollama de Windows: Docker Compose
ejecuta esos servicios, incluido Ollama, en contenedores.

## 1. Requisitos previos

- Windows 10/11 de 64 bits compatible con la versión actual de Docker Desktop.
- Virtualización habilitada en BIOS/UEFI.
- WSL 2. Docker Desktop requiere WSL 2 actualizado. **No requiere instalar Ubuntu**:
  si no hay una distribución Linux instalada, Docker Desktop usa su propio entorno
  `docker-desktop`. La documentación actual de Docker indica WSL 2.1.5 o posterior.
- Docker Desktop configurado para ejecutar contenedores Linux.
- Internet durante la primera descarga de imágenes y del modelo de IA.
- Espacio libre suficiente. Se recomienda **16 GB de RAM y al menos 20 GB libres**
  para las imágenes, los datos y el modelo. Docker Desktop indica 8 GB de RAM como
  requisito de hardware de WSL 2; con 8 GB el stack completo puede sentirse lento.

Comprueba Windows con `Windows + R` → `winver`. Para ver WSL y las distribuciones
Linux instaladas, abre PowerShell y ejecuta:

```powershell
wsl --status
wsl --version
wsl --list --verbose
```

`wsl --list --verbose` puede indicar que no hay distribuciones instaladas; eso no
impide usar Docker Desktop. La versión de WSL predeterminada debe ser 2.

## 2. Instalar o actualizar WSL 2

Si `wsl --status` y `wsl --version` funcionan y WSL 2 está disponible, continúa al
siguiente paso. Si WSL no está instalado, abre **PowerShell como administrador** y
ejecuta:

```powershell
wsl --install --no-distribution
```

Reinicia Windows cuando lo solicite. Esa opción instala WSL sin agregar Ubuntu. Si
WSL ya estaba instalado pero necesita actualización, ejecuta como administrador:

```powershell
wsl --update
```

Después del reinicio, comprueba de nuevo:

```powershell
wsl --status
wsl --version
```

Si la virtualización aparece deshabilitada, habilita Intel VT-x o AMD-V/SVM en
BIOS/UEFI. La ubicación y el nombre de esa opción dependen del fabricante del PC.

## 3. Instalar Docker Desktop

1. Descarga Docker Desktop para Windows desde la [página oficial de Docker](https://docs.docker.com/desktop/setup/install/windows-install/).
2. Ejecuta el instalador. Selecciona **Use WSL 2 instead of Hyper-V** si aparece.
3. Reinicia si el instalador lo pide y abre Docker Desktop desde Inicio.
4. Espera a que indique que el motor está en ejecución. En Settings, confirma que
   está activo el motor WSL 2 y que Docker está usando **Linux containers**.

En PowerShell comprueba que el CLI puede conectarse al motor:

```powershell
docker --version
docker compose version
docker run --rm hello-world
```

El último comando debe terminar mostrando `Hello from Docker!`. Si PowerShell no
reconoce `docker`, espera a que Docker Desktop termine de iniciar; si sigue igual,
cierra y vuelve a abrir PowerShell.

## 4. Preparar el proyecto

Recibe la carpeta del proyecto o descomprime el ZIP. Abre PowerShell en la carpeta
raíz `soc-lite`, donde están `docker-compose.yml` y `.env.example`. Comprueba la ruta:

```powershell
Get-ChildItem docker-compose.yml, db\schema.sql, .env.example
```

Prepara una configuración local:

```powershell
Copy-Item .env.example .env
```

Para la demostración local, revisa los valores de seguridad de `.env` y cambia las
claves marcadas como ejemplo. No compartas ese archivo: contiene credenciales. Las
claves de servicios externos como VirusTotal son opcionales para arrancar.

## 5. Elegir dónde guardar Ollama y sus modelos

### Opción recomendada: Ollama dentro de Docker Compose

El `docker-compose.yml` ya incluye el servicio `ollama` y el volumen persistente
`ollama_models`. No instales Ollama aparte para seguir esta guía. Al arrancar,
Compose descarga el modelo definido en `.env` mediante el contenedor temporal
`ollama-pull`. Por defecto, es `llama3.1:8b`, cuyo archivo de modelo ocupa unos
4,9 GB; las imágenes de Docker y los demás datos también usan espacio.

### Si el disco C: tiene poco espacio

Docker guarda en su disco virtual las imágenes, los contenedores y los volúmenes,
incluido `ollama_models`. Antes de descargar el modelo, puedes cambiar la ubicación
del disco virtual de Docker Desktop a una unidad con más espacio:

1. Abre Docker Desktop → **Settings → Resources → Advanced**.
2. En **Disk image location**, elige una carpeta en la unidad con espacio (por
   ejemplo, `D:\DockerData`) y aplica el cambio.
3. Espera a que Docker Desktop termine de mover el disco virtual y vuelva a iniciar.

Esto mueve los datos de Docker Desktop en conjunto, no sólo el modelo de Ollama.
No muevas manualmente el archivo virtual desde el Explorador de archivos; usa la
opción de Docker Desktop.

### Alternativa: descargar un modelo más pequeño

Si no quieres cambiar la ubicación de Docker, antes del primer arranque edita `.env`
y cambia:

```dotenv
OLLAMA_MODEL=llama3.1:8b
```

por esta opción de menor tamaño:

```dotenv
OLLAMA_MODEL=llama3.2:3b
```

`llama3.2:3b` ocupa alrededor de 2 GB según el catálogo de Ollama. También existe
`llama3.2:1b`, de alrededor de 1,3 GB, pero un modelo más pequeño puede dar
respuestas y triajes menos sólidos. El nombre elegido se usa tanto para descargar
el modelo como para que el microservicio LangChain lo consulte. Cambia `.env` antes
de arrancar el stack por primera vez.

No hace falta instalar la aplicación Ollama de Windows para ninguna de estas dos
opciones. Si ya tienes Ollama instalado en Windows, este Compose no lo usa por
defecto: el backend de IA apunta al servicio `ollama` dentro de la red Docker.

## 6. Crear el certificado HTTPS local

Nginx requiere un certificado para `localhost`. Desde la raíz del proyecto ejecuta:

```powershell
New-Item -ItemType Directory -Force .\deploy\certs | Out-Null
docker run --rm -v "${PWD}/deploy/certs:/certs" alpine/openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /certs/privkey.pem -out /certs/fullchain.pem -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

El navegador puede advertir que el certificado es autofirmado. Es normal para esta
prueba local; no lo uses en un servidor público.

## 7. Construir y arrancar SOC-Lite

Desde la misma carpeta raíz, con Docker Desktop abierto:

```powershell
docker compose up -d --build
docker compose ps -a
```

En el primer arranque Docker descarga varias imágenes. Ollama descarga el modelo en
segundo plano. Mira el progreso con:

```powershell
docker compose logs -f ollama-pull
```

Cuando aparezca `Modelo listo`, usa `Ctrl+C` para volver a PowerShell; esto sólo
cierra la vista de logs, no detiene el stack. Luego revisa:

```powershell
docker compose ps
```

Abre estos servicios:

- SOC-Lite: [https://localhost](https://localhost)
- n8n: [http://localhost:5678](http://localhost:5678)
- Documentación de la API: [https://localhost/docs](https://localhost/docs)

Las cuentas iniciales de SOC-Lite están en la tabla **Credenciales de demostración**
del README. n8n puede solicitar las credenciales configuradas en `.env`. Los
workflows de ejemplo están en la carpeta `n8n/` y se importan desde la interfaz.

## 8. Detener y volver a iniciar

Para detener los contenedores sin borrar los datos guardados:

```powershell
docker compose down
```

Para volver a iniciarlos:

```powershell
docker compose up -d
```

No uses `docker compose down -v` si quieres conservar la base de datos, los datos
de n8n y los modelos descargados.

## Problemas frecuentes

- **`docker` no se reconoce:** abre Docker Desktop y espera que el motor termine de
  iniciar; después abre una nueva ventana de PowerShell.
- **WSL solicita reinicio o actualización:** reinicia Windows o ejecuta
  `wsl --update` en PowerShell como administrador.
- **No hay espacio suficiente:** cambia `Disk image location` en Docker Desktop o
  elige `OLLAMA_MODEL=llama3.2:3b` antes de iniciar.
- **nginx reinicia:** verifica que existan `deploy\certs\fullchain.pem` y
  `deploy\certs\privkey.pem`.
- **La IA no tría alertas:** espera `Modelo listo` y revisa
  `docker compose logs --tail 100 ollama langchain`.
- **Ver estado y logs:** `docker compose ps -a` y
  `docker compose logs --tail 100 backend frontend nginx`.

## Referencias oficiales

- [Instalar Docker Desktop en Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop con WSL 2](https://docs.docker.com/desktop/features/wsl/)
- [Comandos básicos de WSL, incluido `--no-distribution`](https://learn.microsoft.com/windows/wsl/basic-commands)
- [Ubicación del disco y recursos de Docker Desktop](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
- [Modelos llama3.1 en Ollama](https://ollama.com/library/llama3.1/tags)
- [Modelos llama3.2 en Ollama](https://ollama.com/library/llama3.2/tags)

# Datasets públicos para SOC-Lite

> **Ámbito:** datasets y fuentes abiertas reutilizables en SOC-Lite — triaje automático de alertas (SIEM
> **Wazuh** + enriquecimiento de IOCs + razonamiento **LLM** con LangChain) — con persistencia en el esquema
> PostgreSQL de `db/schema.sql` (`alerts`, `enrichment_data`, `triage_results`, `assets`, `incidents`) y
> orquestación con **n8n**, *jobs* ETL y microservicio LLM.
>
> **Verificación:** todas las URLs se comprobaron con carga HTTP directa durante esta sesión; cuando no fue
> posible, se indica. **No se han inventado URLs, tamaños ni fechas**: lo no confirmado figura como
> *no verificado*. El catálogo **CISA KEV** consultado se identificaba como `catalogVersion 2026.10.13`.

**Leyenda:** ✅ verificado por carga directa (HTTP 200) · ⚠️ parcial (citada por una fuente verificada, o solo
indexada) · ❌ roto / no accesible.

---

## 1. Logs y telemetría de seguridad / SIEM

- **Loghub** autoriza expresamente uso «for research or academic work»: **no concede uso comercial**.
- **AIT-LDS v2.1** es el mejor *ground truth* (etiquetas por número de línea); sus variantes `*_no-pcaps.zip`
  pesan 522 MB–1,3 GB frente a 7,1–26,5 GB del ZIP completo.
- **CIC-IDS2017 / CSE-CIC-IDS2018** son datos de red (PCAP/CSV de flujos), no logs de host: necesitan una capa
  de traducción a alertas Wazuh/Suricata antes de entrar en `alerts`.
- **Mordor** fue absorbido por **Security-Datasets**: `github.com/OTRF/mordor` sirve hoy el README de ese proyecto.

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **Loghub** (HDFS, BGL, Thunderbird, Windows, Linux, OpenSSH, Apache…) | LogPAI (CUHK) | [github.com/logpai/loghub](https://github.com/logpai/loghub) · ficheros [Zenodo 8196385](https://zenodo.org/records/8196385) | «Research or academic work» + citación (no comercial) | HDFS_v1 11.175.629 líneas/1,47 GiB (38,7 h); BGL 4.747.963/708,76 MiB; Thunderbird 211,2 M líneas/29,60 GiB; Windows 114,6 M/26,09 GiB; OpenSSH 655.146 | Pruebas de *parseo*, volumen y rendimiento de ingesta; **sin etiquetas de ataque** (salvo anomalías de fiabilidad) |
| ✅ **AIT Log Data Set V2.1** | AIT (Austria) + TU Wien | [zenodo.org/records/19483937](https://zenodo.org/records/19483937) (v2.x DOI [5789064](https://doi.org/10.5281/zenodo.5789064)) | Acceso abierto; licencia específica **no verificada** | 8 testbeds, 137,1 GB, logs + PCAP + etiquetas JSON; ene–feb 2022; ataques de 40 min a 10 h | **Ground truth por línea**: escaneos nmap/WPScan/dirb, webshell (CVE-2020-24186), *password cracking*, escalada, RCE, exfiltración DNS |
| ✅ **AIT-ADS (Alert Data Set)** | AIT | [zenodo.org/records/8263181](https://zenodo.org/records/8263181) | **no verificado** | Alertas de IDS open source derivadas de AIT-LDS v2 | Alertas ya correlacionadas: entrada directa a `alerts` y medición de FP contra *ground truth* |
| ✅ **CIC-IDS2017** | CIC/UNB | [unb.ca/cic/datasets/ids-2017.html](https://www.unb.ca/cic/datasets/ids-2017.html) · descarga [cicresearch.ca](http://cicresearch.ca/CICDataset/CIC-IDS-2017/) | «Publicly available for researchers» + citar Sharafaldin et al. (ICISSP 2018) | PCAP + CSV CICFlowMeter (>80 *features*): 11,0/11/13/7,8/8,3 GB por día; 3–7 jul 2017 | Etiquetas por día y ataque (FTP/SSH-Patator, DoS/DDoS, Heartbleed, web, infiltración, botnet) para alertas Suricata/Zeek con veredicto conocido |
| ✅ **CSE-CIC-IDS2018** | CSE (Canadá) + CIC/UNB; espejo AWS Open Data | [registry.opendata.aws/cse-cic-ids2018](https://registry.opendata.aws/cse-cic-ids2018/) · ficha [ids-2018](https://www.unb.ca/cic/datasets/ids-2018.html) | Según ficha CIC/UNB; citación obligatoria | Bucket `cse-cic-ids2018` (ca-central-1) sin cuenta AWS; tráfico y logs de 420 PCs + 30 servidores; 80 *features*; 2018 | **Base principal del conjunto de validación**: 7 escenarios con etiquetas de flujo |
| ✅ **OTRF Security-Datasets** (incluye Mordor) | Open Threat Research | [github.com/OTRF/Security-Datasets](https://github.com/OTRF/Security-Datasets) · [securitydatasets.com](https://securitydatasets.com) | README con *badge* MIT **y** sección GPL-3.0: **contradicción del propio repositorio** | JSON/EVTX/ZIP por técnica ATT&CK; 2019–actualidad | Telemetría de laboratorio para validar `mitre_technique`, `raw_payload` y `triage_results.mitre_techniques` |
| ✅ **EVTX-ATTACK-SAMPLES** | S. Bousseaden (comunidad) | [github.com/sbousseaden/EVTX-ATTACK-SAMPLES](https://github.com/sbousseaden/EVTX-ATTACK-SAMPLES) | GPL (`LICENSE.GPL`) | **200** EVTX + `Winlogbeat-Bulk-Read.ps1`; mapa ATT&CK Navigator; ~2018–2022 | *Replay* de EVTX hacia Wazuh para probar decodificadores y reglas |
| ✅ **SigmaHQ** | SigmaHQ (F. Roth, N. Bencherchali y comunidad) | [github.com/SigmaHQ/sigma](https://github.com/SigmaHQ/sigma) | **Detection Rule License 1.1** (no permisiva estándar) | >3000 reglas YAML en 5 tipos, incluidas `rules-compliance`; continua | *Baseline* de severidad; las reglas de cumplimiento mapean CIS/NIST/ISO 27001 |
| ✅ **Splunk attack_data** | Splunk Inc. | [github.com/splunk/attack_data](https://github.com/splunk/attack_data) | Apache-2.0 | **>9 GB** por Git LFS; Sysmon, 4688, CrowdStrike… con YAML por técnica; ~2020–2025 | *Replay* en `alerts` con `mitre_technique` ya presente en el YAML |

**Con cautela:** **NSL-KDD** ([unb.ca/cic/datasets/nsl.html](https://www.unb.ca/cic/datasets/nsl.html), ⚠️ no
comprobada; datos de 1999) y **UNSW-NB15**, cuya página oficial devolvió **HTTP 504** durante la verificación
([research.unsw.edu.au/projects/unsw-nb15-dataset](https://research.unsw.edu.au/projects/unsw-nb15-dataset) ❌;
alternativa [UNSWorks](https://unsworks.unsw.edu.au/entities/dataset/4dc0e35c-6196-4c9d-945a-c50b981e5955)).
También útiles: **Malware-Traffic-Analysis.net** (PCAP + IOCs, ⚠️) y **CTU-13/Stratosphere IPS** (botnet, ⚠️).

---

## 2. Inteligencia de amenazas / IOCs (TI)

- **abuse.ch** (verificado): uso gratuito solo **no lucrativo** con límites de consultas; el uso comercial
  «may require a paid subscription» gestionada por **Spamhaus**; requiere cuenta en [auth.abuse.ch](https://auth.abuse.ch/);
  prohíbe obras derivadas sin consentimiento.
- **MISP** publica **108 feeds de 52 proveedores** (47 CSV, 43 texto libre, 18 MISP) con metadatos en
  `feed-metadata/defaults.json`: vía más rápida para poblar `enrichment_data`.
- Registrar siempre `enrichment_data.provider` y guardar `raw_response` para auditoría (ISO 27001 A.8.15).

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **abuse.ch: URLhaus, Feodo Tracker, ThreatFox, MalwareBazaar, SSLBL** | abuse.ch AG + Spamhaus | [urlhaus.abuse.ch](https://urlhaus.abuse.ch/) · [feodotracker.abuse.ch](https://feodotracker.abuse.ch/) · [threatfox.abuse.ch](https://threatfox.abuse.ch/) · [bazaar.abuse.ch](https://bazaar.abuse.ch/) · [sslbl.abuse.ch](https://sslbl.abuse.ch/) · [ToU](https://abuse.ch/terms-of-use/) | Terms of Use abuse.ch (gratis no lucrativo; comercial vía Spamhaus) | CSV/API/texto; export MISP de hashes; plataformas activas desde 2015–2020 (fechas de inicio no verificadas) | IOCs de IP, dominio, URL, hash y JA3 para `enrichment_data` (`indicator_type`, `verdict`, `score`) |
| ⚠️ **AlienVault OTX** | LevelBlue/AT&T | [otx.alienvault.com](https://otx.alienvault.com/) | ToS; *tier* gratuito (**detalle no verificado**) | API JSON + *pulses*; 2008–actualidad | Enriquecimiento multi-indicador y contexto de campaña (`provider='otx'`) |
| ✅ **MISP Default Feeds + CIRCL OSINT** | MISP Project / CIRCL | [misp-project.org/feeds](https://www.misp-project.org/feeds/) · [CIRCL feed-osint](https://www.circl.lu/doc/misp/feed-osint) (verificado vía catálogo MISP) | MISP (software AGPL); **cada feed con su licencia** | 108 feeds/52 proveedores: Feodo CSV, SSLBL CSV, MalwareBazaar MISP, IPsum 1-8, Emerging Threats | Origen único de muchos *feeds* de `enrichment_data` y de la correlación local de IOCs |
| ✅ **PhishTank + OpenPhish** | Cisco Talos / OpenPhish | [phishtank.org](https://phishtank.org/) · [feed público OpenPhish](https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt) | PhishTank: EULA de Cisco; OpenPhish: **no verificado** | API + lista de URLs activas; PhishTank con IDs >9,5 M observados; 2006–actualidad | Verificación de URL de correo/proxy reportada y disparo de `incidents.category='phishing'` |
| ⚠️ **Spamhaus (DROP/DWS/EDROP) + Emerging Threats** | Spamhaus / Proofpoint | [spamhaus.org/drop](https://www.spamhaus.org/drop/) · [compromised-ips.txt](https://rules.emergingthreats.net/blockrules/compromised-ips.txt) (verificado vía MISP) | Spamhaus ToU y ET Open: **no verificados** | Listas de redes/IP + reglas Suricata; continua | Listas de alta confianza para reducir FP y reglas del sensor |
| ✅ **MITRE ATT&CK (STIX 2.1 / TAXII)** | The MITRE Corporation | [attack-stix-data](https://github.com/mitre-attack/attack-stix-data) · [attack.mitre.org](https://attack.mitre.org/) | [ATT&CK Terms of Use](https://attack.mitre.org/resources/terms-of-use/) | Colecciones STIX 2.1 (Enterprise, Mobile, ICS) + `index.json`; versiones continuas | Poblar `alerts.mitre_technique/mitre_tactic` y `incidents.mitre_tactics` (ExploitDB, CAPEC y D3FEND se tratan en las categorías 7 y 4) |

---

## 3. Reputación de IP / dominios / hashes

- **Alexa Top 1M está discontinuado**: la propia página de **Tranco** (verificada) confirma que «The Alexa
  ranking has been removed […] as it is no longer available».
- **Tranco** integra fuentes con licencias distintas: Cisco Umbrella (gratuita), Majestic (CC BY 3.0), CrUX
  (CC BY-SA 4.0) y **Cloudflare Radar (CC BY-NC 4.0) → componente no comercial**.
- **MaxMind GeoLite2** (EULA verificada): atribución obligatoria («This product includes GeoLite Data created
  by MaxMind»), CC BY-SA 4.0 sobre elementos protegibles, uso interno de negocio, **destrucción de versiones
  antiguas en 30 días** y prohibición de identificar hogares o personas.

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **AbuseIPDB API** | AbuseIPDB LLC | [abuseipdb.com/api](https://www.abuseipdb.com/api) · [docs v2](https://docs.abuseipdb.com/) | Terms of Use del sitio (**comercial no verificado**) | JSON; **1.000 consultas/día** gratis y 3.000/día *webmaster* (verificado); APIv1 retirada el 2020-02-01 | `enrichment_data.provider='abuseipdb'`: `score`, `malicious_count`, país, ASN |
| ✅ **VirusTotal API** | Google | [docs.virustotal.com](https://docs.virustotal.com/reference/public-vs-premium-api) | API pública **solo no comercial**; **cuotas exactas no verificadas** | JSON (IP, dominio, URL, fichero, comportamiento) | `malicious_count`, `total_engines` y veredicto por indicador |
| ⚠️ **Shodan / Censys / GreyNoise** | Shodan, Censys, GreyNoise | [shodan.io](https://www.shodan.io/) · [search.censys.io](https://search.censys.io/) · [greynoise.io](https://www.greynoise.io/) | ToS propios con *tiers* (**no verificados**) | API JSON; continua | Exposición de la IP atacante y distinción escaneo masivo vs ataque dirigido (reduce FP) |
| ✅ **Tranco + Cisco Umbrella Top 1M** | KU Leuven/TU Delft/UGA; Cisco | [tranco-list.eu](https://tranco-list.eu/) (permanente [/top-1m.csv.zip](https://tranco-list.eu/top-1m.csv.zip)) · [Umbrella static](https://umbrella-static.s3-us-west-1.amazonaws.com/index.html) | Metodología publicada; **fuentes mixtas, incluida CC BY-NC**; Umbrella «free of charge» | 1 M dominios CSV, actualización diaria antes de 00:00 UTC; API y BigQuery | *Feature* de popularidad de dominio para el LLM y *allowlist* anti-FP en proxy |
| ✅ **MaxMind GeoLite2** | MaxMind | [dev.maxmind.com/geoip/geolite2-free-geolocation-data](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) · [EULA](https://www.maxmind.com/en/geolite/eula) | GeoLite EULA + CC BY-SA 4.0 | `.mmdb` y CSV (Country/City/ASN), semanal | Rellenar `enrichment_data.country/asn/as_owner` con la herramienta `geoip_lookup` |
| ⚠️ **IP2Location LITE + DB-IP Lite** | IP2Location / DB-IP | [lite.ip2location.com](https://lite.ip2location.com/) · [db-ip.com/free](https://db-ip.com/free) | CC BY-SA 4.0 y CC BY 4.0 (**no verificados**) | CSV/MMDB mensual | Segunda opinión de geolocalización/ASN cuando GeoLite2 no basta |
| ✅ **RIPE NCC stats + RIRs + PeeringDB + Rapid7 Sonar** | RIPE NCC, APNIC, ARIN, LACNIC, AFRINIC, PeeringDB, Rapid7 | [ftp.ripe.net/pub/stats/ripencc](https://ftp.ripe.net/pub/stats/ripencc/) · [stats.apnic.net](https://stats.apnic.net/) · [opendata.rapid7.com](https://opendata.rapid7.com/) | Políticas de datos abiertos de cada RIR (**no verificadas**) | `delegated-ripencc-latest` ~8 MB y `-extended` ~17 MB, diarios (visto 20261013); histórico desde 2003 | Prefijo → RIR/país/ASN para enriquecer IP origen y detectar rangos residenciales/proxy |

---

## 4. Corpus para evaluación y entrenamiento de LLM en triaje

| Corpus | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **CyberMetric** | Óbuda University y colaboradores | [github.com/cybermetric/CyberMetric](https://github.com/cybermetric/CyberMetric) | **no verificado** (consultar `LICENSE`) | 10.000 preguntas en tamaños 80/500/2.000/10.000, generadas con RAG y verificadas por expertos; 2024 (IEEE CSR) | *Gate* de calidad del modelo antes de producción y comparación entre versiones |
| ✅ **CTIBench** | RIT (Alam, Bhusal, Nguyen, Rastogi) | [arXiv:2406.07599](https://arxiv.org/abs/2406.07599) (NeurIPS 2024 D&B) | Artículo CC BY-NC-SA 4.0; **dataset no verificado**; `github.com/xashru/ctibench` devolvió **404** | Tareas de CTI (CVE-CWE-CVSS, mapeo ATT&CK, QA); 2024 (v3 nov. 2024) | Medir competencia en tareas CTI análogas al triaje |
| ⚠️ **SecEval + Cybench** | Grupo SecLLM; Stanford et al. | [SecEval (Springer)](https://link-hkg.springer.com/chapter/10.1007/978-981-95-6888-8_13) · [cybench.org](https://cybench.org/) | **no verificadas** | Preguntas de seguridad y retos CTF con *sandbox*; 2024–2025 | Comparar modelos locales pequeños y medir capacidad agéntica (*tool-calling*) |
| ✅ **CyberSecEval (PurpleLlama)** | Meta | [github.com/meta-llama/PurpleLlama](https://github.com/meta-llama/PurpleLlama) | Licencia del repositorio (**no verificada**) | *Benchmarks* de seguridad, incluida *prompt injection*; 2023–actualidad | Robustez del agente frente a inyección en `full_log` |
| ✅ **ATT&CK Navigator + Mappings Explorer** | MITRE y MITRE CTID | [attack-navigator](https://mitre-attack.github.io/attack-navigator/) · [ctid.mitre.org/mappings](https://ctid.mitre.org/mappings/) · [repo](https://github.com/center-for-threat-informed-defense/mappings-explorer) | Términos ATT&CK; Mappings Explorer **Apache-2.0** | JSON de *layers*; mapeos ATT&CK ↔ NIST 800-53 / CSF 2.0 / IEC 62443 (ATT&CK v8–14) | Traducir técnicas del triaje a controles y funciones CSF para los reportes |
| ✅ **APTnotes** | Proyecto APTnotes | [github.com/aptnotes/data](https://github.com/aptnotes/data) | **no verificado** | `APTnotes.csv`/`.json` (título, fuente, enlace Box, SHA-1, fecha); informes desde 2008 | Corpus RAG de informes CTI para *few-shot* de razonamiento y atribución |
| ⚠️ **Malpedia + CWE + cvelistV5** | Fraunhofer FKIE; MITRE; CVE Program | [malpedia](https://malpedia.caad.fkie.fraunhofer.de/) · [cwe.mitre.org](https://cwe.mitre.org/) · [cvelistV5](https://github.com/CVEProject/cvelistV5) | Términos académicos / MITRE / CVE (**no verificados**) | Familias y alias, CWE-1000 XML/CSV, JSON 5.x por CVE; continuo | Normalizar familias y aportar texto de CVE/CWE al contexto del LLM |
| ✅ **Informes CTI de proveedores + AIT-ADS** | Mandiant/Google, Microsoft MSTIC, Talos, ESET, Unit 42; AIT | [Google Threat Intelligence](https://cloud.google.com/blog/topics/threat-intelligence) · [AIT-ADS](https://zenodo.org/records/8263181) | Copyright del proveedor con atribución (**no verificado**); AIT **no verificado** | PDF/HTML continuo; alertas etiquetadas derivadas de AIT-LDS v2 | Corpus RAG para `triage_results.summary` y clasificación de alertas ya generadas |

---

## 5. Malware y análisis dinámico

- Todo binario vivo se trata en **laboratorio aislado sin Internet**, con *snapshots* y sin *guest additions*.
- **SOREL-20M** y **MOTIF** entregan muestras **«desarmadas»** (no ejecutables) y *features* listas; en SOREL
  **los benignos no son públicos**, lo que sesga cualquier clasificador entrenado con ellos.

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **MalwareBazaar** | abuse.ch | [bazaar.abuse.ch](https://bazaar.abuse.ch/) · [export MISP](https://bazaar.abuse.ch/downloads/misp/) | ToU abuse.ch (no comercial gratuito) | Muestras + hashes + MISP; 2020–actualidad | Hashes de alertas EDR/Sysmon → `enrichment_data` con familia y *tags* |
| ⚠️ **MalShare** | MalShare | [malshare.com](https://malshare.com/) | «Free» con clave de API (**no verificado**) | API + `malshare.current.all.txt` (verificado vía MISP); 2014–actualidad | *Feed* de hashes conocidos maliciosos |
| ⚠️ **theZoo + VX-Underground + VirusShare** | Comunidad / VX-Underground / VirusShare | [theZoo](https://github.com/ytisf/theZoo) (✅ 200) · [vx-underground.org](https://vx-underground.org/) · [virusshare.com](https://virusshare.com/) | theZoo: GPL-3.0 para la herramienta, **la licencia NO cubre las muestras**; resto **no verificado** | Malware **vivo** cifrado en ZIP con contraseña y hashes; 2012–2021 | **Solo laboratorio aislado**; para SOC-Lite basta hash + metadatos |
| ✅ **EMBER** | Elastic (Endgame) | [github.com/elastic/ember](https://github.com/elastic/ember) · [descarga 2018](https://ember.elastic.co/ember_dataset_2018_2.tar.bz2) | Licencia del repositorio **no verificada**; citar [arXiv:1804.04637](https://arxiv.org/abs/1804.04637) | EMBER2017: 1,1 M PE (v1); EMBER2018: 1 M PE (v2); JSON + vectorizado | *Baseline* de clasificación de PE para `risk_score` y enriquecimiento de hashes |
| ✅ **SOREL-20M** | Sophos + ReversingLabs | [github.com/sophos/SOREL-20M](https://github.com/sophos/SOREL-20M) · S3 `s3://sorel-20m/09-DEC-2020/` | Código Apache-2.0; **datos con Terms and Conditions of Use** (PDF en el repo) | ~**8 TB** de binarios desarmados; `meta.db` 3,5 GB; *features* LightGBM 113/22/37 GB; muestras ≤ dic-2020 | Etiquetas por *timestamp* para simular *concept drift*; recordar el sesgo por ausencia de benignos |
| ✅ **MOTIF** | Booz Allen Hamilton | [github.com/boozallen/MOTIF](https://github.com/boozallen/MOTIF) | «Terms of licensing» del repo (**no verificado**) | 3.095 PE desarmados de **454 familias** + alias + EMBER v2; `MOTIF.7z` 1,47 GB cifrado; informes 2016-01-01→2021-01-01 | *Ground truth* de familia: evaluar atribución del LLM y normalizar alias |
| ✅ **DikeDataset** | iosifache (proyecto `dike`) | [github.com/iosifache/DikeDataset](https://github.com/iosifache/DikeDataset) | Fuentes: figshare **CC BY 4.0** + MalwareBazaar **CC0** | PE y OLE benignos/maliciosos + CSV (`malice`, `trojan`, `ransomware`, `worm`, `backdoor`, `spyware`, `rootkit`, `encrypter`, `downloader`); 2021–2022 aprox. | Etiquetas multi-clase listas para medir el mapeo a `incidents.category` |
| ⚠️ **BODMAS + CIC-MalMem-2022 + MaleVis + ClaMP** | Blue Hexagon/UCSB; CIC/UNB; Hacettepe; comunidad | [BODMAS](https://github.com/whyisyoung/BODMAS) · [CIC-MalMem-2022](https://www.unb.ca/cic/datasets/malmem-2022.html) · [MaleVis](https://web.cs.hacettepe.edu.tr/~selman/malevis/) · [ClaMP](https://github.com/urwithajit9/ClaMP) | Licencias de investigación (**no verificadas**) | ~57.000 muestras temporales; *dumps* de memoria con *features* (2022); ~9.000 imágenes; CSV de cabeceras PE | *Drift* de familias, malware sin fichero y *features* ligeras alternativas a EMBER |

---

## 6. Phishing, correo y fraude

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **PhishTank** | Cisco Talos | [phishtank.org](https://phishtank.org/) · [API](https://phishtank.org/developer_info.php) | EULA de Cisco | API + histórico (IDs >9,5 M observados); 2006–actualidad | Verificar URL de correo reportado antes de abrir incidente |
| ✅ **OpenPhish (feed público)** | OpenPhish | [feed.txt](https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt) | **no verificado** (existe *tier* comercial) | Lista de URLs activas, actualización frecuente | *Watchlist* para correlar con alertas de proxy |
| ⚠️ **Nazario Phishing Corpus** | Jose Nazario | [monkey.org/~jose/phishing/](https://monkey.org/~jose/phishing/) — **disponibilidad actual no verificada** (sigue citándose en publicaciones de 2024) | Uso académico (**no verificado**) | Miles de correos, incluye fraude 419; 2005–2007 y ampliaciones | Corpus etiquetado para el clasificador de correo; confirmar *mirror* antes de depender de él |
| ⚠️ **Enron-Spam + Enron Email Dataset** | Universidad de Atenas; CMU (CALO) | vía [csmining.org](https://csmining.org/) (**no verificado**) · [cs.cmu.edu/~enron](https://www.cs.cmu.edu/~enron/) | **No verificadas**; el corpus Enron es de publicación regulatoria (FERC) | ~33.000 correos (Enron-Spam, **no verificado**, 2006) y ~500.000 correos reales (**no verificado**, 1999–2002) | **Solo con base jurídica y anonimización**: detección de fraude interno |
| ✅ **SpamAssassin Public Corpus** | Apache Software Foundation | [spamassassin.apache.org/old/publiccorpus](https://spamassassin.apache.org/old/publiccorpus/) | **no verificado** (ver `readme.html`) | 10 ficheros `.tar.bz2` de 1,0–2,0 MB (`easy_ham`, `hard_ham`, `spam`); ficheros de 2004–2005 | *Smoke test* de *parsers* MIME y reglas de correo |
| ⚠️ **TREC 2007 Spam Track (+ UCI SMS Spam, CEAS 2008)** | Universidad de Waterloo (Cormack); UCI; CEAS | [treccorpus07](https://plg.uwaterloo.ca/~gvcormac/treccorpus07/) · [mirror GitHub](https://github.com/imdeepmind/Preprocessed-TREC-2007-Public-Corpus-Dataset) · [archive.ics.uci.edu](https://archive.ics.uci.edu/) · [ceas.cc](http://www.ceas.cc/) | Solo investigación / CC BY 4.0 (**no verificadas**) | Corpus cronológico grande (2007); CSV UCI (2008–2011) | Evaluación realista de filtros respetando el orden temporal |

---

## 7. Vulnerabilidades y cumplimiento

- **ISO/IEC 27001:2022 es norma de pago**: puede citarse el número y el título del control, pero **no
  redistribuir** su texto ni la tabla de controles.
- Combinación recomendada de priorización: **CVSS (NVD) + EPSS + CISA KEV** ⇒ `alerts.risk_score` y severidad
  mínima `high` cuando el CVE está en KEV.

| Dataset | Proveedor | URL oficial | Licencia | Tamaño / formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **NVD (feeds + API 2.0)** | NIST | [nvd.nist.gov](https://nvd.nist.gov/) · [API](https://nvd.nist.gov/developers/vulnerabilities) | Dominio público (NIST); **límites de tasa no verificados** | JSON 2.0 + API; 2002–actualidad | CVSS y descripción de CVE: `enrichment_data.indicator_type='cve'` y `risk_score` |
| ⚠️ **CVE Program / cvelistV5** | MITRE + CNAs | [cve.org](https://www.cve.org/) · [cvelistV5](https://github.com/CVEProject/cvelistV5) | Términos CVE (**no verificado**) | JSON 5.x por CVE; 1999–actualidad | Fuente primaria de identificadores y texto para RAG |
| ✅ **CISA KEV** | CISA (EE. UU.) | [catálogo](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) · [JSON](https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json) | Dominio público | Verificado: `catalogVersion 2026.10.13`, **1.741** vulnerabilidades con `knownRansomwareCampaignUse` y `dueDate` | Regla dura de priorización y de escalado a `incidents` |
| ✅ **EPSS (FIRST)** | FIRST.org / Empirical Security | [first.org/epss](https://www.first.org/epss/) · [API](https://api.first.org/epss/) · [repo](https://github.com/empiricalsec/epss_scores) | «Freely and openly accessible» | Probabilidad 0–1 + percentil para todos los CVE; CSV diario | Ajuste fino del `risk_score` y justificación del razonamiento |
| ⚠️ **OSV + GitHub Advisory Database + ExploitDB + VulnDB** | Google/OpenSSF; GitHub; OffSec; Flashpoint | [osv.dev](https://osv.dev/) · [github.com/advisories](https://github.com/advisories) · [exploit-db.com](https://www.exploit-db.com/) · [flashpoint.io](https://flashpoint.io/) | Apache-2.0/CC BY 4.0 y GPLv2 (**no verificados**); VulnDB **comercial** | API/JSON (2021–actualidad) y CSV de exploits (2000–actualidad) | Vulnerabilidades de dependencias y explotabilidad práctica; VulnDB queda como alternativa de pago |
| ⚠️ **CIS Benchmarks/Controls v8.1 + NIST CSF 2.0 + ISO 27001:2022 + NIST SP 800-61r3/800-92** | CIS; NIST; ISO/IEC | [cisecurity.org](https://www.cisecurity.org/cis-benchmarks) · [nist.gov/cyberframework](https://www.nist.gov/cyberframework) · [iso.org/standard/27001](https://www.iso.org/standard/27001) · [csrc.nist.gov](https://csrc.nist.gov/) | CIS: registro y ToU restrictivos; NIST: dominio público; ISO: **pago y no redistribuible** | PDF/Excel; CSF 2.0 (2024), v8.1 (2024), r3 con fecha **no verificada** | Sustento de los reportes: controles A.5.7 *Threat intelligence*, A.5.24 *Incident management planning*, A.8.15 *Logging*, A.8.16 *Monitoring activities* |
| ✅ **Mappings Explorer (CTID)** | MITRE CTID | [ctid.mitre.org/mappings](https://ctid.mitre.org/mappings/) | Apache-2.0 | JSON ATT&CK ↔ CSF 2.0 / 800-53; 2023–actualidad | Traducir `mitre_techniques` a controles y funciones CSF en los informes |

---

## 8. Datos sintéticos y generación de telemetría etiquetada

**Receta para el *ground truth* propio:** (1) laboratorio Wazuh con agentes Windows/Linux y ejecución controlada
de *atomics*; (2) registro `(test_id, técnica, host, inicio, fin)`; (3) *job* ETL que marca como
`true_positive` las alertas cuya `occurred_at` cae en la ventana y asigna `mitre_technique`; (4) muestras
negativas realistas (administración remota, inventario, *backups*) con el *plugin* `human` de Caldera o
*scripts* propios, únicos datos que permiten estimar la tasa de FP de forma honesta.

| Fuente / generador | Proveedor | URL oficial | Licencia | Formato / año | Caso de uso en SOC-Lite |
|---|---|---|---|---|---|
| ✅ **Atomic Red Team** | Red Canary | [github.com/redcanaryco/atomic-red-team](https://github.com/redcanaryco/atomic-red-team) · [atomicredteam.io](https://atomicredteam.io/) | Licencia en `LICENSE.txt` (**no verificada**) | YAML + *scripts*; **1878** *atomics* mapeados a ATT&CK (contador verificado) | Generar telemetría etiquetada por técnica (conjunto S2) |
| ✅ **MITRE/Apache Caldera** | MITRE → Apache Software Foundation | [github.com/apache/caldera](https://github.com/apache/caldera) (el antiguo `mitre/caldera` redirige) · [caldera.apache.org](https://caldera.apache.org/) | Apache-2.0 | Python; servidor C2 + *plugins* (`atomic`, `emu`, `human`, `debrief`); v5.x | Emulación automatizada y generación de ruido benigno (`human`) |
| ✅ **Stratus Red Team** | Datadog | [github.com/DataDog/stratus-red-team](https://github.com/DataDog/stratus-red-team) · [stratus-red-team.cloud](https://stratus-red-team.cloud/) | Licencia del repo (**no verificada**) | Binario Go; AWS/Azure/GCP/Entra ID/K8s; 2021–actualidad | Emulación cloud con guías publicadas de integración con **Wazuh** |
| ⚠️ **Splunk Attack Range + DetectionLab** | Splunk; Chris Long | [attack_range](https://github.com/splunk/attack_range) · [DetectionLab](https://github.com/clong/DetectionLab) | Apache-2.0 y MIT (**no verificados**) | Terraform/Ansible/Vagrant; 2018–2023 | Laboratorios reproducibles que vuelcan EVTX/Sysmon etiquetados |
| ⚠️ **VECTR + Atomic Operator / Invoke-AtomicRedTeam** | SecurityRisk Advisors; comunidad; Red Canary | [VECTR](https://github.com/SecurityRiskAdvisor/VECTR) · [atomic-operator](https://github.com/kyuz0/atomic-operator) · [invoke-atomicredteam](https://github.com/redcanaryco/invoke-atomicredteam) | **no verificadas** | Aplicación web; Python; PowerShell; 2019–actualidad | Registro de campañas *purple team* y ejecución programática desde el ETL |
| ⚠️ **MITRE Engenuity ATT&CK Evaluations + scripts propios** | MITRE Engenuity; SOC-Lite | [evals.mitre-engenuity.org](https://evals.mitre-engenuity.org/) · `tcpreplay`, `scapy`, `Winlogbeat-Bulk-Read.ps1` | Términos MITRE; interna | Informes + PCAP/EVTX; 2018–actualidad | Planes de emulación realistas y *replay* reproducible hacia Wazuh/Suricata |

---

## 9. Integración con SOC-Lite (esquema PostgreSQL y componentes)

| Dataset(s) | Tabla destino | Componente | Mapeo concreto |
|---|---|---|---|
| CIC-IDS2017/2018, AIT-LDS v2.1, PCAP de Malware-Traffic-Analysis, CTU-13 | `alerts` | **Job ETL** (Python) + Suricata/Zeek en laboratorio | `source_type='suricata'\|'zeek'`; `rule_id` = SID; `severity_raw` = prioridad; `raw_payload` = EVE JSON; `alert_fingerprint` = `sha256(source_type\|rule_id\|source_ip\|bucket temporal)` |
| Loghub, EVTX-ATTACK-SAMPLES, OTRF Security-Datasets, Splunk attack_data, SigmaHQ | `alerts`, `assets`, `alerts.rule_groups` | **n8n** (webhook → `/alerts/ingest`) + *replay* `winlogbeat` + traducción Sigma | Wazuh ingiere y reenvía; `agent_name` = host del EVTX; `assets` con el inventario del *dataset*; `rule_groups = ['sigma','attack.<táctica>']` |
| MITRE ATT&CK STIX, ATT&CK Navigator, Mappings Explorer | `alerts.mitre_technique/mitre_tactic`, `triage_results.mitre_techniques`, `incidents.mitre_tactics` | **LangChain** (`attack_lookup`) + ETL de carga STIX | `mitre_technique` = `external_id` (`T1110.001`) y técnicas/tácticas derivadas |
| abuse.ch (URLhaus, ThreatFox, Feodo, SSLBL, MalwareBazaar), OpenPhish, CIRCL, feeds MISP, PhishTank, Spamhaus/ET | `enrichment_data` | **n8n** (cron por *feed*) + **LangChain** (`ioc_lookup`) | `provider = urlhaus\|threatfox\|feodo\|sslbl\|malshare\|otx\|misp`; `indicator_type = ip\|domain\|url\|hash`; `verdict`, `score`, `raw_response`, `expires_at` |
| AbuseIPDB, VirusTotal, OTX, GreyNoise, Shodan, Censys | `enrichment_data` | **LangChain** (`abuseipdb_lookup`, `virustotal_lookup`, ya previstos en el contrato) | `malicious_count`, `total_engines`, `score`; caché con `cache_hit` y `expires_at` para respetar cuotas |
| GeoLite2, IP2Location, DB-IP, RIPE/RIRs, PeeringDB, Rapid7 Sonar | `enrichment_data`, `assets` | **Job ETL** mensual (`.mmdb`/CSV a tabla de apoyo) + `geoip_lookup` | `country`, `asn`, `as_owner`; contexto para `assets.is_internet_facing` |
| NVD, cvelistV5, CISA KEV, EPSS, OSV, ExploitDB | `enrichment_data` (`indicator_type='cve'`), `alerts.risk_score` | **Job ETL diario** + **LangChain** (`cve_context`) | KEV/EPSS alto ⇒ `malicious`/`suspicious`; CVSS+EPSS alimentan `risk_score` |
| AIT-LDS v2.1, AIT-ADS, CIC-IDS2018 etiquetado, telemetría propia (Atomic/Caldera/Stratus) | `triage_results`, `alert_metrics_daily` | **Job ETL de evaluación** + `POST /triage/{alert_id}/feedback` | Etiqueta humana ↔ `human_feedback='confirmed_tp'\|'confirmed_fp'`; agregados en `alert_metrics_daily` (`alerts_tp`, `alerts_fp`, `mttt_avg_sec`) y `v_fp_rate_by_rule` |
| Enron, SpamAssassin, TREC 2007, Nazario, PhishTank | `alerts` (canal correo) e `incidents.category` | **n8n** (ingesta de correo) + ETL | `rule_groups = ['email','phishing']`; `incidents.category='phishing'` |
| theZoo, VX-Underground, VirusShare, MalShare | `enrichment_data` (solo hashes) | **Laboratorio aislado** + *job* de *hashing* | Nunca se cargan binarios en la BD: solo hash, familia y veredicto |
| CyberMetric, CTIBench, SecEval, Cybench, CyberSecEval, APTnotes, Malpedia, informes CTI | Fuera de la BD (evaluación/RAG) | **LangChain** (índice vectorial) | Resultados trazados en `triage_results` (`model_name`, `prompt_version`, `trace_id`) e `integrations.code` |

Cada fuente se declara en `integrations` (`code`, `category = siem|ti|llm`, `base_url`, `secret_ref` hacia
Vault/`.env`, `last_ok_at`, `last_error`), y cada carga ETL debe dejar rastro en `audit_log`
(`module='integrations'`, `action='CREATE'|'UPDATE'`) — coherente con ISO 27001 A.8.15.

---

## 10. Licencias y consideraciones legales / privacidad

| Dataset / fuente | Licencia | ¿Uso comercial? | ¿Atribución? | Advertencias (RGPD / terceros / riesgo) |
|---|---|---|---|---|
| Loghub, NSL-KDD, UNSW-NB15, AIT-LDS/ADS | «Research or academic work»; abierto (AIT); **no verificado** (NSL/UNSW) | Loghub **No**; resto no verificado | Sí | Logs sin sanear (usuarios, rutas, hosts); AIT es sintético (sin PII, con *drift*) |
| CIC-IDS2017 / CSE-CIC-IDS2018 | «For researchers» + citación | No verificado (probable restricción) | Sí (Sharafaldin et al. 2018) | PCAP con posibles datos personales en *payloads* HTTP/DNS |
| OTRF Security-Datasets / Mordor / EVTX-ATTACK-SAMPLES | README con *badge* MIT **y** GPL-3.0 (**contradicción**); EVTX GPL | GPL permitiría uso comercial con copyleft | Sí | Telemetría de laboratorio con hosts/usuarios ficticios |
| SigmaHQ | **Detection Rule License 1.1** | Revisar DRL (no permisiva) | Sí | Reglas, sin datos personales |
| Splunk attack_data | Apache-2.0 | Sí | Sí | Artefactos de ataque: no ejecutar |
| abuse.ch (URLhaus, Feodo, ThreatFox, MalwareBazaar, SSLBL) | Terms of Use abuse.ch | **Requiere suscripción Spamhaus** | Sí | IOCs pueden apuntar a víctimas; prohibidas obras derivadas sin consentimiento |
| MISP feeds / CIRCL / Spamhaus / ET Open | Mixta (software MISP AGPL); Spamhaus y ET **no verificados** | Depende del *feed* | Sí | Verificar licencia **feed por feed** antes de comercializar |
| PhishTank / OpenPhish / AlienVault OTX | EULA Cisco / **no verificado** / ToS | No verificado | Sí | URLs de *phishing* con posibles **tokens o PII de víctimas**; *pulses* de calidad variable |
| AbuseIPDB | Terms of Use | **Free tier no comercial** (verificar `/legal`) | Sí | Comentarios con posible PII; **1.000 consultas/día** |
| VirusTotal / Shodan / Censys / GreyNoise | ToS propios | **VT: API pública solo no comercial**; resto según *tier* | Sí | No subir muestras con datos de clientes; redistribución a menudo prohibida |
| Tranco / Cisco Umbrella Top 1M | Metodología abierta; fuentes mixtas | **Cautela**: Tranco incluye fuente CC BY-NC | Sí | Solo rankings de dominios: riesgo bajo de PII |
| MaxMind GeoLite2 / IP2Location LITE / DB-IP Lite | GeoLite EULA + CC BY-SA 4.0 / CC BY-SA / CC BY (**no verificados**) | Uso interno de negocio con condiciones | **Sí, obligatoria** | Sin redistribución; borrar versiones antiguas (30 días); **prohibido** identificar hogares/personas |
| RIPE / RIRs / PeeringDB / Rapid7 Sonar | Políticas de datos abiertos | Sí, con atribución | Sí | Los registros contienen contactos organizativos |
| CISA KEV / NVD / EPSS / NIST CSF / SP 800-x | Dominio público | Sí | Recomendada | Sin PII |
| ISO/IEC 27001:2022 / CIS Benchmarks-Controls | ISO: **norma de pago**; CIS: registro + ToU restrictivos | Solo con licencia adquirida | Citar número de control | **No redistribuir** texto ni tablas |
| EMBER / SOREL-20M / MOTIF / DikeDataset / BODMAS / CIC-MalMem / MaleVis / ClaMP | Mixta (Apache-2.0 en código SOREL; CC BY 4.0/CC0 en fuentes de Dike); varias **no verificadas** | **Restringido a investigación** en varios casos | Sí | Muestras desarmadas; SOREL **sin benignos**; nunca ejecutar en red corporativa |
| theZoo / VX-Underground / VirusShare / MalShare | GPL-3.0 en la herramienta; **no cubre las muestras** | **No recomendado** | — | Malware **vivo**: riesgo legal y operativo alto |
| Enron (Email y Enron-Spam), SpamAssassin, TREC 2007, Nazario, fraude 419 | Publicación regulatoria (FERC) / académica / **no verificadas** | No verificado | Sí | **Datos personales de terceros** → base jurídica, minimización y anonimización (RGPD/LOPDGDD); textos con cuentas bancarias |

---

## 11. Pipeline de evaluación del modelo de triaje

### 11.1 Construcción del *ground truth* (TP/FP)

| Subconjunto | Fuentes | Volumen objetivo | Etiqueta | Uso |
|---|---|---|---|---|
| **S1 – Inyección controlada** | AIT-LDS v2.1 (etiquetas por línea), CSE-CIC-IDS2018, AIT-ADS | 300–400 alertas | `true_positive`/`false_positive` por diseño | Pruebas unitarias y regresión de *prompts* |
| **S2 – Emulación propia** | Wazuh + Atomic Red Team / Stratus Red Team / Caldera | 300–400 | `true_positive` (técnica conocida) | Verificar `mitre_techniques` y `risk_score` |
| **S3 – Ruido benigno** | Ventanas sin ataque de AIT-LDS, días benignos de CIC-IDS, actividad administrativa propia | 300–400 | `false_positive`/`benign` | **Estimación honesta de la tasa de FP** |
| **S4 – *Holdout* de producción** | Alertas reales con *feedback* humano | ≥200 | `confirmed_tp`/`confirmed_fp` | Validación externa y detección de *drift* |

**Reglas:** etiquetado **ciego y doble** por dos analistas con árbitro y **κ de Cohen ≥ 0,7**; partición por
**día y host** (nunca aleatoria) para evitar *leakage*; `alert_fingerprint` determinista para reproducir cada
alerta; etiqueta persistida en `triage_results.human_feedback` + `feedback_comment`.

### 11.2 Métricas

| Métrica | Definición operativa | Objetivo propuesto |
|---|---|---|
| Precisión por veredicto | TP/(TP+FP) por `triage_verdict` | ≥0,90 en `true_positive` |
| Recall y F1 por severidad | TP/(TP+FN) y media armónica por nivel | Recall ≥0,95 en `critical`; F1 ≥0,85 en `high`/`critical` |
| Matriz de severidad | Severidad SIEM vs severidad LLM (`v_alert_triage`) | Desviación ≥2 niveles <5 % |
| Tasa de FP | `v_fp_rate_by_rule.fp_pct` global y por regla | <10 % global; reglas >40 % ⇒ revisión |
| Técnica ATT&CK | % correcta frente a la emulada (S2) | ≥0,80 en *top-3* |
| IOC inventado | IOCs del LLM ausentes en `enrichment_data` | **0 tolerancia** (<0,5 %) |
| Calibración | Brier/ECE de `confidence` | ECE <0,10 |
| Latencia y coste | `latency_ms`, `tokens_in/out`, `cost_usd` | p95 <10 s, dentro de presupuesto |
| Ahorro de analista y ruido | (MTTT manual − MTTT asistido) × alertas; `automation_rate`; `noise_reduction` | ≥60 % de ahorro; ruido ≥0,70 sin aumentar FN |

### 11.3 Protocolo de validación

1. **Baseline obligatorio**: LLM frente a reglas deterministas (severidad Wazuh + KEV/EPSS) sobre el mismo conjunto.
2. **Reproducibilidad**: `prompt_version` congelada, `temperature=0.1`, 3 ejecuciones por alerta registradas en
   `triage_results` (`model_name`, `model_provider`, `langsmith_run_id`, `trace_id`).
3. **Comparación de modelos**: al menos un modelo local (Ollama) y uno externo si `policy.allow_external_llm`,
   con CyberMetric/CTIBench como *gate* previo y S1–S4 como prueba final.
4. **Regresión en CI**: cada cambio de *prompt*, *tool* o modelo reejecuta S1+S2 y bloquea el *merge* si empeora
   el F1 crítico o sube la tasa de FP.
5. **Muestreo humano**: ≥30 alertas/semana revisadas por el `soc_manager`, alimentando `human_feedback` y
   `kpi_targets` (`fp_rate`, `mttt_critical`).
6. **Deriva**: comparar `alert_metrics_daily` mes a mes; si S4 cae >10 %, reevaluar y re-indexar el corpus RAG.

---

## 12. Datasets NO recomendados o con cautela

| Fuente | Motivo |
|---|---|
| **Alexa Top 1M** | **Descontinuado** (confirmado por Tranco). Usar Tranco o Umbrella Top 1M |
| **NSL-KDD / UNSW-NB15** | Datos de 1999 y página oficial con **HTTP 504** en la verificación: solo *smoke test* y tras confirmar términos |
| **theZoo / VX-Underground / VirusShare** | Malware vivo y licencia que no cubre las muestras: solo laboratorio aislado |
| **Kaggle y *mirrors* sin licencia explícita** | Licencia opaca o «research only» (p. ej. Microsoft Malware Prediction): usar la URL primaria del proveedor |
| **SOREL-20M / MOTIF (muestras)** | Desarmadas y con ToU; **sin benignos** en SOREL ⇒ sesgo severo en clasificadores |
| **CIC-IDS2017/2018 sin depurar** | Ruido de etiquetas, desbalanceo y fondo sintético (limitaciones documentadas en la literatura; **no verificado aquí**): limpiar y validar por día |
| **CTIBench vía `github.com/xashru/ctibench`** | **404** en las rutas comprobadas: usar la referencia del *paper* hasta localizar el repositorio canónico |
| **APIs con *free tier* no comercial** (VirusTotal, AbuseIPDB, abuse.ch, Shodan, Censys, MalShare) | Incompatibles con un producto comercial: preparar sustitutos con licencia compatible |
| **Caldera expuesto en red** | CVE-2025-27364 (RCE) y advertencia del proyecto de no exponerlo a Internet |
| **GeoLite2 redistribuido** | El EULA prohíbe divulgar el `.mmdb` a terceros: no empaquetarlo en el producto |
| **Enron / corpora de correo real** | Datos personales de terceros: requieren base jurídica y anonimización |
| **Loghub (Windows/Linux/Apache)** | Sin etiquetas de ataque: inútil para medir precisión |

---

## 13. Anexo: registro de verificación de URLs

**✅ Verificadas por carga directa (HTTP 200):** todas las filas marcadas ✅ en las secciones 1–8 (sus enlaces
están en la propia tabla); no se repiten aquí.

**⚠️ Parciales:** [VirusTotal public vs premium](https://docs.virustotal.com/reference/public-vs-premium-api)
(200, pero las cuotas numéricas no se pudieron leer) · [NVD API](https://nvd.nist.gov/developers/vulnerabilities)
(200 con contenido mínimo renderizado por JS) · [NSL-KDD](https://www.unb.ca/cic/datasets/nsl.html) y **todas
las URLs marcadas ⚠️ en las tablas**: no comprobadas con carga directa, verificar antes de integrarlas.

**❌ Rotas o no accesibles:** [UNSW-NB15](https://research.unsw.edu.au/projects/unsw-nb15-dataset) (**HTTP 504**) ·
`sophos/SOREL-20M/main/README.md` (**404**; la rama `master` responde 200) ·
`github.com/xashru/ctibench` (**404** en `main` y `master`).

---

## 14. Resumen

- **Categorías cubiertas (8):** (1) logs y telemetría/SIEM, (2) inteligencia de amenazas e IOCs,
  (3) reputación de IP/dominio/hash, (4) corpus para evaluación y entrenamiento de LLM en triaje,
  (5) malware y análisis dinámico, (6) phishing/correo/fraude, (7) vulnerabilidades y cumplimiento,
  (8) datos sintéticos y generación de telemetría etiquetada.
- **Entradas listadas:** **57** filas de dataset (≈50 datasets y *feeds* diferenciados — abuse.ch agrupa
  URLhaus, Feodo, ThreatFox, MalwareBazaar y SSLBL — más generadores, *corpus* RAG y fuentes de cumplimiento),
  de las cuales **39 están verificadas por carga directa (HTTP 200)** y **18 son parciales o *no verificadas***;
  además se documentan **1 URL rota (HTTP 504)** y **1 repositorio no localizable (404)**.
- **Decisiones accionables:** *ground truth* = **CSE-CIC-IDS2018 + AIT-LDS v2.1 + AIT-ADS + OTRF Security-Datasets**;
  contexto y priorización = **ATT&CK STIX + Mappings Explorer + CISA KEV/EPSS**; `enrichment_data` =
  **abuse.ch + MISP + GeoLite2 + RIRs**; telemetría etiquetada propia = **Atomic Red Team / Stratus Red Team /
  Caldera**; y **evitar** Alexa, NSL-KDD, muestras vivas de malware y todo *free tier* no comercial si SOC-Lite
  se explota comercialmente.

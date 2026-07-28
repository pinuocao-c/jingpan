import { useEffect, useRef } from 'react'

const VERTEX_SOURCE = `#version 300 es
  in vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const FRAGMENT_SOURCE = `#version 300 es
  precision highp float;

  uniform sampler2D u_backdrop;
  uniform vec2 u_resolution;
  uniform vec4 u_rect;
  uniform vec4 u_material;
  uniform vec3 u_pointer;
  uniform int u_mode;

  out vec4 outColor;

  float sdRoundBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
  }

  vec3 sampleBackdrop(vec2 pixel) {
    vec2 uv = clamp(pixel / u_resolution, vec2(0.001), vec2(0.999));
    uv.y = 1.0 - uv.y;
    return texture(u_backdrop, uv).rgb;
  }

  float lensDistance(vec2 pixel) {
    vec2 center = u_rect.xy + u_rect.zw * 0.5;
    vec2 halfSize = u_rect.zw * 0.5;
    return sdRoundBox(pixel - center, halfSize, min(u_material.y, min(halfSize.x, halfSize.y)));
  }

  vec2 physicalOffset(
    vec3 incident,
    vec3 surfaceNormal,
    float glassHeight,
    float ior,
    out float opticalPath
  ) {
    vec3 insideRay = refract(incident, surfaceNormal, 1.0 / ior);
    float insideDistance = glassHeight / max(-insideRay.z, 0.10);
    vec3 exitRay = refract(insideRay, vec3(0.0, 0.0, 1.0), ior);
    if (dot(exitRay, exitRay) < 0.0001) {
      exitRay = reflect(insideRay, vec3(0.0, 0.0, 1.0));
    }
    float airGap = 3.0;
    float airDistance = airGap / max(-exitRay.z, 0.12);
    float directDistance = (glassHeight + airGap) / max(-incident.z, 0.12);
    opticalPath = insideDistance * ior + airDistance;
    return insideRay.xy * insideDistance
      + exitRay.xy * airDistance
      - incident.xy * directDistance;
  }

  void main() {
    vec2 pixel = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
    vec3 original = sampleBackdrop(pixel);
    if (u_mode == 0) {
      outColor = vec4(original, 1.0);
      return;
    }

    float sd = lensDistance(pixel);
    if (sd > 0.0) {
      float lift = clamp(u_material.x / 58.0, 0.75, 1.75);
      vec2 shadowOffset = vec2(-2.0, 3.2) * lift;
      float shadowDistance = lensDistance(pixel - shadowOffset);
      float shadowSoftness = 4.5 + u_material.x * 0.045;
      float contactShadow = 1.0 - smoothstep(-1.0, shadowSoftness, shadowDistance);
      contactShadow *= smoothstep(0.0, 3.2, sd);
      if (contactShadow < 0.002) discard;
      float shadowStrength = (0.040 + u_material.z * 0.014) * contactShadow;
      outColor = vec4(original * (1.0 - shadowStrength), 1.0);
      return;
    }

    vec2 ex = vec2(1.0, 0.0);
    vec2 ey = vec2(0.0, 1.0);
    float gx = lensDistance(pixel + ex) - lensDistance(pixel - ex);
    float gy = lensDistance(pixel + ey) - lensDistance(pixel - ey);
    vec2 edgeNormal = normalize(vec2(gx, gy) + vec2(0.00001));

    float inward = max(-sd, 0.0);
    float maximumInward = max(1.0, min(u_rect.z, u_rect.w) * 0.5);
    float section = clamp(inward / maximumInward, 0.0, 1.0);

    // A single continuous convex volume. There is no flat hollow center and no
    // second underlay surface. The height field rises continuously from the rim.
    float capRoot = sqrt(max(section * (2.0 - section), 0.0001));
    float hover = u_material.z;
    float clarity = u_material.w;
    float physicalDepth = u_material.x * (1.42 + hover * 0.07);
    float wallWidth = clamp(physicalDepth * 0.16, 7.0, 17.0);
    float glassHeight = physicalDepth * capRoot;
    float heightSlope = clamp(
      (physicalDepth / maximumInward) * (1.0 - section) / capRoot,
      0.0,
      5.2
    );
    vec3 normal = normalize(vec3(edgeNormal * heightSlope, 1.0));

    vec2 lensCenter = u_rect.xy + u_rect.zw * 0.5;
    float viewFocalLength = u_resolution.y * 1.62;
    vec3 incident = normalize(vec3((pixel - lensCenter) / viewFocalLength, -1.0));
    float ior = 1.46;
    float surfaceF0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
    float slabReflectance = (2.0 * surfaceF0) / (1.0 + surfaceF0);

    float pathR;
    float pathG;
    float pathB;
    vec2 offsetR = physicalOffset(incident, normal, glassHeight, ior - 0.004, pathR);
    vec2 offsetG = physicalOffset(incident, normal, glassHeight, ior, pathG);
    vec2 offsetB = physicalOffset(incident, normal, glassHeight, ior + 0.006, pathB);
    vec3 refracted = vec3(
      sampleBackdrop(pixel + offsetR).r,
      sampleBackdrop(pixel + offsetG).g,
      sampleBackdrop(pixel + offsetB).b
    );

    float averagePath = (pathR + pathG + pathB) / 3.0;
    vec3 transmission = exp(-vec3(0.00044, 0.00024, 0.00010) * averagePath);
    refracted *= transmission;

    float cosTheta = clamp(-dot(incident, normal), 0.0, 1.0);
    float fresnel = surfaceF0 + (1.0 - surfaceF0) * pow(1.0 - cosTheta, 5.0);
    float edgeFresnel = clamp((fresnel - surfaceF0) / (1.0 - surfaceF0), 0.0, 1.0);
    vec2 sunPosition = u_resolution * vec2(0.92, 0.045);
    vec2 lightVector = (sunPosition - pixel) / u_resolution;
    vec3 light = normalize(vec3(lightVector * vec2(2.1, 2.35), 0.72));
    vec3 viewDirection = -incident;
    vec3 halfVector = normalize(light + viewDirection);
    float edgeProximity = 1.0 - smoothstep(1.0, wallWidth, inward);
    vec2 sunEdgeDirection = normalize(vec2(0.68, -0.74));
    float directionalEdge = smoothstep(0.44, 0.96, dot(edgeNormal, sunEdgeDirection) * 0.5 + 0.5);
    float sharpSpecular = pow(max(dot(normal, halfVector), 0.0), 178.0)
      * edgeProximity * directionalEdge * 0.24;
    float broadSpecular = pow(max(dot(normal, halfVector), 0.0), 42.0)
      * edgeProximity * directionalEdge * 0.018;
    float caustic = pow(1.0 - section, 4.2)
      * pow(max(dot(edgeNormal, light.xy), 0.0), 2.8)
      * edgeProximity
      * 0.042;

    float pointerDistance = length(pixel - u_pointer.xy);
    float pointerSpecular = exp(-pointerDistance * pointerDistance / 21000.0)
      * u_pointer.z
      * edgeProximity
      * (0.006 + edgeFresnel * 0.028);

    vec3 reflection = mix(vec3(0.78, 0.89, 0.97), vec3(1.0), 0.80);
    float reflectionWeight = clamp(slabReflectance * 0.72 + edgeFresnel * 0.20, 0.0, 0.27);
    vec3 glass = mix(refracted, reflection, reflectionWeight);
    glass += vec3(sharpSpecular + broadSpecular + caustic + pointerSpecular);
    float edgeRefraction = 1.0 - smoothstep(wallWidth * 0.45, wallWidth * 1.55, inward);
    glass = mix(original, glass, 0.075 + edgeRefraction * 0.925);
    float glassLuminance = dot(glass, vec3(0.2126, 0.7152, 0.0722));
    vec3 clarityCoat = mix(glass, vec3(mix(glassLuminance, 0.985, 0.34)), 0.14);
    glass = mix(glass, clarityCoat, clarity);

    float silhouetteFade = smoothstep(0.0, 1.7, inward);
    vec3 color = mix(original, glass, silhouetteFade);
    float glassWall = 1.0 - smoothstep(0.0, wallWidth, inward);
    float innerWall = smoothstep(1.8, 4.6, inward)
      * (1.0 - smoothstep(wallWidth * 0.64, wallWidth, inward));
    float facing = clamp(0.44 + dot(edgeNormal, sunEdgeDirection) * 0.56, 0.0, 1.0);
    color *= 1.0 - glassWall * (1.0 - facing) * 0.045;
    color += vec3(0.012, 0.022, 0.030) * innerWall * facing;
    float rim = 1.0 - smoothstep(0.0, 4.8, inward);
    vec3 rimColor = mix(vec3(0.48, 0.64, 0.76), vec3(1.0), facing);
    color = mix(color, rimColor, rim * mix(0.12, 0.29, facing));

    outColor = vec4(color, 1.0);
  }
`

function parsePixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export default function LiquidGlassRenderer(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance'
    })
    if (!gl) {
      document.documentElement.dataset.glassFallback = 'true'
      return
    }

    const backdropCanvas = document.createElement('canvas')
    const backdrop = backdropCanvas.getContext('2d', { alpha: false })
    if (!backdrop) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let dpr = 1
    let frame = 0
    let lastLensRefresh = 0
    let lenses: HTMLElement[] = []
    let pointerX = window.innerWidth * 0.5
    let pointerY = window.innerHeight * 0.5
    let pointerVisible = 0

    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('无法创建 WebGL 着色器')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? 'WebGL 着色器编译失败')
      }
      return shader
    }

    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SOURCE))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      document.documentElement.dataset.glassFallback = 'true'
      return
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const uniforms = {
      backdrop: gl.getUniformLocation(program, 'u_backdrop'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      rect: gl.getUniformLocation(program, 'u_rect'),
      material: gl.getUniformLocation(program, 'u_material'),
      pointer: gl.getUniformLocation(program, 'u_pointer'),
      mode: gl.getUniformLocation(program, 'u_mode')
    }

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const width = Math.max(1, Math.round(window.innerWidth * dpr))
      const height = Math.max(1, Math.round(window.innerHeight * dpr))
      canvas.width = width
      canvas.height = height
      backdropCanvas.width = width
      backdropCanvas.height = height
      gl.viewport(0, 0, width, height)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null)
    }

    const refreshLenses = (): void => {
      lenses = [...document.querySelectorAll<HTMLElement>([
        '[data-liquid-glass]',
        '.hero-card',
        '.disk-ring',
        '.metric-card',
        '.content-card',
        '.empty-state',
        '.category-row',
        '.sticky-action',
        '.action-list > button',
        '.update-banner',
        '.primary-button',
        '.secondary-button',
        '.danger-button',
        '.progress-dialog',
        '.confirm-dialog',
        '.chat-platform-grid > button',
        '.duplicate-summary-grid > div',
        '.duplicate-summary-grid > button',
        '.app-summary-grid > button',
        '.file-kind-tabs > button',
        '.settings-list > div'
      ].join(','))]
        .filter((element, index, values) => values.indexOf(element) === index)
        .slice(0, 120)
    }

    const drawBackdrop = (): void => {
      const width = backdropCanvas.width
      const height = backdropCanvas.height
      const pageScroller = document.querySelector<HTMLElement>('.page-container')
      const scroll = (pageScroller?.scrollTop ?? 0) * dpr
      const gradient = backdrop.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, '#f3faff')
      gradient.addColorStop(0.52, '#eaf6ff')
      gradient.addColorStop(1, '#e4f2fc')
      backdrop.fillStyle = gradient
      backdrop.fillRect(0, 0, width, height)

      const sun = backdrop.createRadialGradient(
        width * 0.91,
        height * 0.035,
        0,
        width * 0.91,
        height * 0.035,
        width * 0.50
      )
      sun.addColorStop(0, 'rgba(255,255,255,0.16)')
      sun.addColorStop(0.45, 'rgba(255,255,255,0.03)')
      sun.addColorStop(1, 'rgba(255,255,255,0)')
      backdrop.fillStyle = sun
      backdrop.fillRect(0, 0, width, height)

      backdrop.lineWidth = Math.max(1, dpr * 0.7)
      backdrop.strokeStyle = 'rgba(65,105,145,0.035)'
      const gap = 156 * dpr
      const offset = ((-scroll * 0.18) % gap + gap) % gap
      for (let y = offset - gap; y < height + gap; y += gap) {
        backdrop.beginPath()
        backdrop.moveTo(0, y)
        backdrop.lineTo(width, y)
        backdrop.stroke()
      }

      backdrop.strokeStyle = 'rgba(65,105,145,0.022)'
      const verticalGap = 218 * dpr
      for (let x = width * 0.08; x < width + verticalGap; x += verticalGap) {
        backdrop.beginPath()
        backdrop.moveTo(x, 0)
        backdrop.lineTo(x, height)
        backdrop.stroke()
      }

      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, backdropCanvas)
    }

    const render = (now: number): void => {
      drawBackdrop()
      if (now - lastLensRefresh > 500) {
        refreshLenses()
        lastLensRefresh = now
      }

      gl.disable(gl.SCISSOR_TEST)
      gl.uniform1i(uniforms.mode, 0)
      gl.uniform1i(uniforms.backdrop, 0)
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      gl.enable(gl.SCISSOR_TEST)
      gl.uniform1i(uniforms.mode, 1)
      for (const element of lenses) {
        const rect = element.getBoundingClientRect()
        if (
          rect.width < 2
          || rect.height < 2
          || rect.right <= 0
          || rect.bottom <= 0
          || rect.left >= window.innerWidth
          || rect.top >= window.innerHeight
        ) continue

        const style = window.getComputedStyle(element)
        const radius = parsePixels(element.dataset.glassRadius ?? style.borderTopLeftRadius, 16)
        const depth = parsePixels(
          element.dataset.glassDepth ?? '',
          rect.height <= 64 ? 66 : rect.height <= 150 ? 58 : 50
        )
        const hover = element.matches(':hover') && !reduceMotion.matches ? 1 : 0
        const shadowMargin = Math.ceil(14 * dpr)
        const left = Math.max(0, Math.floor(rect.left * dpr) - shadowMargin)
        const bottom = Math.max(0, Math.floor((window.innerHeight - rect.bottom) * dpr) - shadowMargin)
        const right = Math.min(canvas.width, Math.ceil(rect.right * dpr) + shadowMargin)
        const top = Math.min(canvas.height, Math.ceil((window.innerHeight - rect.top) * dpr) + shadowMargin)
        const width = right - left
        const height = top - bottom
        if (width <= 0 || height <= 0) continue

        gl.scissor(left, bottom, width, height)
        gl.uniform4f(
          uniforms.rect,
          rect.left * dpr,
          rect.top * dpr,
          rect.width * dpr,
          rect.height * dpr
        )
        const clarity = parsePixels(element.dataset.glassClarity ?? '', 0)
        gl.uniform4f(uniforms.material, depth * dpr, radius * dpr, hover, Math.min(1, Math.max(0, clarity)))
        gl.uniform3f(uniforms.pointer, pointerX * dpr, pointerY * dpr, hover * pointerVisible)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      gl.disable(gl.SCISSOR_TEST)
      frame = window.requestAnimationFrame(render)
    }

    const onPointerMove = (event: PointerEvent): void => {
      pointerX = event.clientX
      pointerY = event.clientY
      pointerVisible = 1
    }
    const onPointerLeave = (): void => {
      pointerVisible = 0
    }
    const observer = new MutationObserver(refreshLenses)
    observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true })
    window.addEventListener('resize', resize, { passive: true })
    document.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)
    resize()
    refreshLenses()
    frame = window.requestAnimationFrame(render)
    document.documentElement.dataset.glassRenderer = 'webgl2'

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      delete document.documentElement.dataset.glassRenderer
    }
  }, [])

  return <canvas ref={canvasRef} className="liquid-glass-canvas" aria-hidden="true" />
}

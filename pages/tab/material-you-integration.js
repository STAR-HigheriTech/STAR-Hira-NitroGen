/**
 * Material You UI + Cyber/Tech Theme Integration
 * 融合Material You设计系统与科技风格样式
 */

(function() {
    'use strict';

    // ========== Material You Design System ==========
    const MaterialYouStyles = `
        /* ========== Material You Design System Variables ========== */
        :root {
            /* Material You Dynamic Color Variables - Blue Theme (Default) */
            --md-sys-color-primary: #165DFF;
            --md-sys-color-on-primary: #FFFFFF;
            --md-sys-color-primary-container: #E2EEFF;
            --md-sys-color-on-primary-container: #001B3D;
            
            --md-sys-color-secondary: #36CFC9;
            --md-sys-color-on-secondary: #FFFFFF;
            --md-sys-color-secondary-container: #C7F5F3;
            --md-sys-color-on-secondary-container: #00201E;
            
            --md-sys-color-tertiary: #722ED1;
            --md-sys-color-on-tertiary: #FFFFFF;
            --md-sys-color-tertiary-container: #F0E2FF;
            --md-sys-color-on-tertiary-container: #2A004F;
            
            --md-sys-color-error: #BA1A1A;
            --md-sys-color-on-error: #FFFFFF;
            --md-sys-color-error-container: #FFDAD6;
            --md-sys-color-on-error-container: #410002;
            
            --md-sys-color-background: #F2F3F5;
            --md-sys-color-on-background: #1D2129;
            --md-sys-color-surface: #FFFFFF;
            --md-sys-color-on-surface: #1D2129;
            --md-sys-color-surface-variant: #E1E2E6;
            --md-sys-color-on-surface-variant: #43474E;
            --md-sys-color-outline: #73777F;
            --md-sys-color-outline-variant: #C3C6CF;
            
            --md-sys-color-inverse-surface: #2F3136;
            --md-sys-color-inverse-on-surface: #F2F3F5;
            --md-sys-color-inverse-primary: #A5C8FF;
            
            --md-sys-color-scrim: #000000;
            
            /* Material You Elevation Shadows */
            --md-sys-elevation-1: 0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px rgba(0, 0, 0, 0.3);
            --md-sys-elevation-2: 0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px rgba(0, 0, 0, 0.3);
            --md-sys-elevation-3: 0px 4px 8px 3px rgba(0, 0, 0, 0.15), 0px 1px 3px rgba(0, 0, 0, 0.3);
            --md-sys-elevation-4: 0px 6px 10px 4px rgba(0, 0, 0, 0.15), 0px 2px 3px rgba(0, 0, 0, 0.3);
            --md-sys-elevation-5: 0px 8px 12px 6px rgba(0, 0, 0, 0.15), 0px 4px 4px rgba(0, 0, 0, 0.3);
            
            /* Material You Shape - Rounded Corners */
            --md-sys-shape-corner-small: 8px;
            --md-sys-shape-corner-medium: 12px;
            --md-sys-shape-corner-large: 16px;
            --md-sys-shape-corner-full: 9999px;
            --md-sys-shape-corner-extra-large: 28px;
            --md-sys-shape-corner-fully-round: 50%;
            
            /* Material You Motion - Easing Curves */
            --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
            --md-sys-motion-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);
            --md-sys-motion-easing-decelerated: cubic-bezier(0, 0, 0, 1);
            --md-sys-motion-easing-accelerated: cubic-bezier(0.2, 0, 1, 1);
            
            /* Material You Motion - Durations */
            --md-sys-motion-duration-short: 200ms;
            --md-sys-motion-duration-medium: 400ms;
            --md-sys-motion-duration-long: 500ms;
            --md-sys-motion-duration-extra-long: 600ms;
            
            /* State layer opacity values */
            --md-sys-state-hover: 0.08;
            --md-sys-state-focus: 0.12;
            --md-sys-state-pressed: 0.12;
            --md-sys-state-dragged: 0.16;
            --md-sys-state-hover-on-color: 0.08;
            
            /* Cyber/Tech Theme Colors */
            --cyber-primary: #165DFF;
            --cyber-secondary: #36CFC9;
            --cyber-accent: #722ED1;
            --cyber-dark: #1D2129;
            --cyber-light: #F2F3F5;
            --cyber-neon: #00FFFF;
            --cyber-electric: #0080FF;
        }
    `;

    // ========== Material You Component Styles ==========
    const MaterialYouComponents = `
        /* ========== Material You Surface Components ========== */
        .md-surface {
            background-color: var(--md-sys-color-surface);
            border-radius: var(--md-sys-shape-corner-large);
            box-shadow: var(--md-sys-elevation-1);
            transition: box-shadow var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard),
                        background-color var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard);
        }
        
        .md-surface-elevated {
            background-color: var(--md-sys-color-surface);
            border-radius: var(--md-sys-shape-corner-extra-large);
            box-shadow: var(--md-sys-elevation-3);
            transition: box-shadow var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard),
                        transform var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard);
        }
        
        .md-surface-elevated:hover {
            box-shadow: var(--md-sys-elevation-4);
            transform: translateY(-2px);
        }
        
        .md-surface-elevated:active {
            box-shadow: var(--md-sys-elevation-2);
            transform: translateY(0);
        }
        
        /* ========== Material You Filled Button ========== */
        .md-button-filled {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 10px 24px;
            border: none;
            border-radius: var(--md-sys-shape-corner-full);
            background-color: var(--md-sys-color-primary);
            color: var(--md-sys-color-on-primary);
            font-family: 'Inter', system-ui, sans-serif;
            font-size: 0.875rem;
            font-weight: 500;
            letter-spacing: 0.1px;
            text-transform: uppercase;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
        }
        
        .md-button-filled:hover {
            box-shadow: var(--md-sys-elevation-2);
        }
        
        .md-button-filled:active {
            transform: scale(0.98);
        }
        
        /* Ripple effect */
        .md-button-filled .ripple {
            position: absolute;
            border-radius: 50%;
            background-color: var(--md-sys-color-on-primary);
            transform: scale(0);
            animation: md-ripple-expand 0.6s ease-out;
            pointer-events: none;
        }
        
        @keyframes md-ripple-expand {
            from {
                transform: scale(0);
                opacity: 1;
            }
            to {
                transform: scale(2.5);
                opacity: 0;
            }
        }
        
        /* ========== Material You Cards ========== */
        .md-card {
            background-color: var(--md-sys-color-surface);
            border-radius: var(--md-sys-shape-corner-extra-large);
            box-shadow: var(--md-sys-elevation-1);
            overflow: hidden;
            transition: all var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-emphasized);
        }
        
        .md-card:hover {
            box-shadow: var(--md-sys-elevation-3);
        }
        
        .md-card-interactive {
            cursor: pointer;
            position: relative;
        }
        
        .md-card-interactive::before {
            content: '';
            position: absolute;
            inset: 0;
            background-color: var(--md-sys-color-on-surface);
            opacity: 0;
            transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
            pointer-events: none;
        }
        
        .md-card-interactive:hover::before {
            opacity: var(--md-sys-state-hover);
        }
        
        /* ========== Material You Navigation Bar ========== */
        .md-navigation-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px;
            background-color: var(--md-sys-color-surface);
            border-radius: var(--md-sys-shape-corner-extra-large);
            box-shadow: var(--md-sys-elevation-3);
            gap: 12px;
            z-index: 1000;
        }
        
        .md-nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 12px 24px;
            border: none;
            border-radius: var(--md-sys-shape-corner-medium);
            background-color: transparent;
            color: var(--md-sys-color-on-surface-variant);
            cursor: pointer;
            position: relative;
            text-decoration: none;
            transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
        }
        
        .md-nav-item:hover {
            background-color: rgba(67, 71, 78, 0.08);
        }
        
        .md-nav-item.active {
            background-color: var(--md-sys-color-secondary-container);
            color: var(--md-sys-color-on-secondary-container);
        }
        
        .md-nav-item .indicator {
            position: absolute;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 24px;
            height: 3px;
            border-radius: 3px 3px 0 0;
            background-color: var(--md-sys-color-primary);
            opacity: 0;
            transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
        }
        
        .md-nav-item.active .indicator {
            opacity: 1;
        }
        
        /* ========== Material You FAB ========== */
        .md-fab {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 56px;
            height: 56px;
            border: none;
            border-radius: var(--md-sys-shape-corner-extra-large);
            background-color: var(--md-sys-color-primary-container);
            color: var(--md-sys-color-on-primary-container);
            cursor: pointer;
            position: fixed;
            bottom: 24px;
            right: 24px;
            box-shadow: var(--md-sys-elevation-3);
            transition: all var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-emphasized);
            z-index: 1000;
        }
        
        .md-fab:hover {
            box-shadow: var(--md-sys-elevation-4);
            transform: translateY(-2px);
        }
        
        .md-fab:active {
            box-shadow: var(--md-sys-elevation-2);
            transform: translateY(0);
        }
        
        /* ========== Material You App Bar ========== */
        .md-app-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 24px;
            background-color: var(--md-sys-color-surface);
            box-shadow: var(--md-sys-elevation-2);
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 1000;
        }
        
        .md-app-bar-title {
            font-family: 'Inter', system-ui, sans-serif;
            font-size: 1.25rem;
            font-weight: 500;
            color: var(--md-sys-color-on-surface);
        }
    `;

    // ========== Cyber + Material You Hybrid Components ==========
    const CyberMaterialComponents = `
        /* ========== Hybrid Cyber + Material You Components ========== */
        .cyber-material-card {
            background: linear-gradient(145deg, #ffffff 0%, #f8f9fa 100%);
            border-radius: 28px;
            box-shadow: var(--md-sys-elevation-2), 0 0 40px rgba(22, 93, 255, 0.1);
            overflow: hidden;
            position: relative;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .cyber-material-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--cyber-primary), var(--cyber-secondary), var(--cyber-accent));
        }
        
        .cyber-material-card:hover {
            transform: translateY(-8px);
            box-shadow: var(--md-sys-elevation-4), 0 0 60px rgba(22, 93, 255, 0.2);
        }
        
        .cyber-material-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 14px 32px;
            border: none;
            border-radius: 9999px;
            background: linear-gradient(135deg, var(--cyber-primary) 0%, var(--cyber-secondary) 100%);
            color: white;
            font-family: 'Inter', system-ui, sans-serif;
            font-size: 0.875rem;
            font-weight: 600;
            letter-spacing: 0.5px;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 15px rgba(22, 93, 255, 0.3);
        }
        
        .cyber-material-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 25px rgba(22, 93, 255, 0.4);
        }
        
        .cyber-material-button:active {
            transform: translateY(0);
        }
        
        .cyber-material-button .ripple {
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            transform: scale(0);
            animation: md-ripple-expand 0.8s ease-out;
            pointer-events: none;
        }
        
        .cyber-material-icon-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 56px;
            height: 56px;
            border: none;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--cyber-primary) 0%, var(--cyber-secondary) 100%);
            color: white;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 15px rgba(22, 93, 255, 0.3);
        }
        
        .cyber-material-icon-button:hover {
            transform: scale(1.1) rotate(5deg);
            box-shadow: 0 6px 25px rgba(22, 93, 255, 0.4);
        }
        
        .cyber-material-icon-button:active {
            transform: scale(0.95);
        }
        
        .cyber-material-icon-button .ripple {
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            transform: scale(0);
            animation: md-ripple-expand 0.6s ease-out;
            pointer-events: none;
        }
        
        /* ========== Glassmorphism with Material You ========== */
        .material-glass {
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: var(--md-sys-shape-corner-extra-large);
            box-shadow: var(--md-sys-elevation-2);
        }
        
        /* ========== Loading Animation ========== */
        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(22, 93, 255, 0.3);
            border-top: 4px solid #165DFF;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        /* ========== Interactive States ========== */
        .state-layer {
            position: absolute;
            inset: 0;
            background-color: var(--md-sys-color-on-surface);
            border-radius: inherit;
            opacity: 0;
            pointer-events: none;
            transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
        }
        
        .state-layer-hover:hover {
            opacity: var(--md-sys-state-hover);
        }
        
        .state-layer-focus:focus {
            opacity: var(--md-sys-state-focus);
        }
        
        .state-layer-pressed:active {
            opacity: var(--md-sys-state-pressed);
        }
        
        .state-layer-dragged {
            opacity: var(--md-sys-state-dragged);
        }
        
        /* ========== Smooth Transitions ========== */
        .smooth-transition {
            transition: all var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-standard);
        }
        
        .smooth-transition-fast {
            transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
        }
        
        .smooth-transition-slow {
            transition: all var(--md-sys-motion-duration-long) var(--md-sys-motion-easing-emphasized);
        }
    `;

    // ========== Utility Classes ==========
    const UtilityClasses = `
        /* ========== Utility Classes ========== */
        .content-auto {
            content-visibility: auto;
        }
        .text-shadow {
            text-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .transition-custom {
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .bg-gradient-blue {
            background: linear-gradient(135deg, #165DFF 0%, #36CFC9 100%);
        }
        .bg-cyber-gradient {
            background: linear-gradient(135deg, #165DFF 0%, #36CFC9 50%, #722ED1 100%);
        }
        .glass-morphism {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .neon-glow {
            box-shadow: 0 0 20px rgba(22, 93, 255, 0.3), 0 0 40px rgba(22, 93, 255, 0.2), 0 0 80px rgba(22, 93, 255, 0.1);
        }
        .tech-border {
            position: relative;
            overflow: hidden;
        }
        .tech-border::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(22, 93, 255, 0.4), transparent);
            transition: left 0.5s;
        }
        .tech-border:hover::before {
            left: 100%;
        }
    `;

    // ========== Animation Keyframes ==========
    const AnimationKeyframes = `
        /* ========== Animation Keyframes ========== */
        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            50% { transform: translateY(-20px) rotate(2deg); }
        }
        
        @keyframes glow {
            0% { box-shadow: 0 0 20px rgba(22, 93, 255, 0.4); }
            100% { box-shadow: 0 0 30px rgba(22, 93, 255, 0.8), 0 0 60px rgba(22, 93, 255, 0.4); }
        }
        
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translateY(50px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        @keyframes slideInLeft {
            from {
                opacity: 0;
                transform: translateX(-50px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        @keyframes slideInRight {
            from {
                opacity: 0;
                transform: translateX(50px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        @keyframes matrix {
            0% { transform: translateY(-100vh); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(100vh); opacity: 0; }
        }
        
        @keyframes techScan {
            0% { transform: translateX(-100%); }
            50% { transform: translateX(0%); }
            100% { transform: translateX(100%); }
        }
        
        @keyframes particle {
            0%, 100% { 
                transform: translateY(0px) translateX(0px) scale(1);
                opacity: 0.7;
            }
            25% { 
                transform: translateY(-20px) translateX(10px) scale(1.1);
                opacity: 1;
            }
            50% { 
                transform: translateY(-40px) translateX(-5px) scale(0.9);
                opacity: 0.8;
            }
            75% { 
                transform: translateY(-60px) translateX(15px) scale(1.05);
                opacity: 0.9;
            }
        }
        
        @keyframes md-elevation-rise {
            from {
                opacity: 0;
                transform: translateY(8px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        @keyframes gradientShift {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }
    `;

    // ========== JavaScript Utilities ==========
    const MaterialYouJS = `
        // ========== Material You Ripple Effect ==========
        function createRipple(event, button) {
            const ripple = document.createElement('span');
            ripple.classList.add('ripple');
            
            const rect = button.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = event.clientX - rect.left - size / 2;
            const y = event.clientY - rect.top - size / 2;
            
            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';
            
            button.appendChild(ripple);
            
            setTimeout(() => {
                ripple.remove();
            }, 600);
        }
        
        // ========== Initialize Ripple Effects ==========
        function initializeRippleEffects() {
            const rippleButtons = document.querySelectorAll('.md-button-filled, .md-fab, .cyber-material-button, .cyber-material-icon-button');
            
            rippleButtons.forEach(button => {
                button.addEventListener('click', function(e) {
                    createRipple(e, this);
                });
            });
        }
        
        // ========== Intersection Observer for Animations ==========
        function initializeScrollAnimations() {
            const observerOptions = {
                threshold: 0.1,
                rootMargin: '0px 0px -50px 0px'
            };
            
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('animate-slide-up');
                        observer.unobserve(entry.target);
                    }
                });
            }, observerOptions);
            
            const animatedElements = document.querySelectorAll('.cyber-material-card, .service-card, .project-card');
            animatedElements.forEach(el => observer.observe(el));
        }
        
        // ========== Smooth Scroll ==========
        function initializeSmoothScroll() {
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
                anchor.addEventListener('click', function(e) {
                    e.preventDefault();
                    const target = document.querySelector(this.getAttribute('href'));
                    if (target) {
                        target.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start'
                        });
                    }
                });
            });
        }
        
        // ========== Navigation Active State ==========
        function initializeNavigation() {
            const navItems = document.querySelectorAll('.md-nav-item');
            const sections = document.querySelectorAll('section[id]');
            
            function updateActiveNav() {
                const scrollY = window.pageYOffset;
                
                sections.forEach(section => {
                    const sectionHeight = section.offsetHeight;
                    const sectionTop = section.offsetTop - 100;
                    const sectionId = section.getAttribute('id');
                    
                    if (scrollY > sectionTop && scrollY <= sectionTop + sectionHeight) {
                        navItems.forEach(item => {
                            item.classList.remove('active');
                            if (item.getAttribute('href') === '#' + sectionId) {
                                item.classList.add('active');
                            }
                        });
                    }
                });
            }
            
            window.addEventListener('scroll', updateActiveNav);
        }
        
        // ========== Card Hover Effects ==========
        function initializeCardEffects() {
            const cards = document.querySelectorAll('.cyber-material-card, .md-card');
            
            cards.forEach(card => {
                card.addEventListener('mousemove', function(e) {
                    const rect = this.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    
                    this.style.setProperty('--mouse-x', x + 'px');
                    this.style.setProperty('--mouse-y', y + 'px');
                });
            });
        }
        
        // ========== Theme Toggle ==========
        function initializeThemeToggle() {
            const themeToggle = document.querySelector('.md-icon-button[data-theme-toggle]');
            if (themeToggle) {
                themeToggle.addEventListener('click', function() {
                    document.body.classList.toggle('dark-theme');
                    const isDark = document.body.classList.contains('dark-theme');
                    localStorage.setItem('theme', isDark ? 'dark' : 'light');
                });
            }
        }
        
        // ========== Initialize All Material You Effects ==========
        function initializeMaterialYou() {
            document.addEventListener('DOMContentLoaded', function() {
                initializeRippleEffects();
                initializeScrollAnimations();
                initializeSmoothScroll();
                initializeNavigation();
                initializeCardEffects();
                initializeThemeToggle();
                
                console.log('Material You UI initialized successfully');
            });
        }
        
        // Start initialization
        initializeMaterialYou();
    `;

    // ========== Inject Styles ==========
    function injectStyles() {
        const styleSheet = document.createElement('style');
        styleSheet.textContent = MaterialYouStyles + MaterialYouComponents + CyberMaterialComponents + UtilityClasses + AnimationKeyframes;
        document.head.appendChild(styleSheet);
    }

    // ========== Inject JavaScript ==========
    function injectJavaScript() {
        const script = document.createElement('script');
        script.textContent = MaterialYouJS;
        document.body.appendChild(script);
    }

    // ========== Main Entry Point ==========
    function init() {
        if (document.head) {
            injectStyles();
        }
        if (document.body) {
            injectJavaScript();
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                injectStyles();
                injectJavaScript();
            });
        }
    }

    // Initialize
    init();

})();

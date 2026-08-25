// Localization System for Rainföll Website
class LocalizationManager {
    constructor() {
        this.currentLanguage = 'en';
        this.translations = {};
        this.fallbackLanguage = 'en';
        this.supportedLanguages = {
            'en': { name: 'English', flag: '🇺🇸', dir: 'ltr' },
            'es': { name: 'Español', flag: '🇪🇸', dir: 'ltr' },
            'fr': { name: 'Français', flag: '🇫🇷', dir: 'ltr' },
            'de': { name: 'Deutsch', flag: '🇩🇪', dir: 'ltr' },
            'it': { name: 'Italiano', flag: '🇮🇹', dir: 'ltr' },
            'pt': { name: 'Português', flag: '🇵🇹', dir: 'ltr' },
            'nl': { name: 'Nederlands', flag: '🇳🇱', dir: 'ltr' },
            'sv': { name: 'Svenska', flag: '🇸🇪', dir: 'ltr' },
            'pl': { name: 'Polski', flag: '🇵🇱', dir: 'ltr' },
            'zh': { name: '中文', flag: '🇨🇳', dir: 'ltr' }
        };
        
        this.init();
    }

    async init() {
        // Load saved language preference
        const savedLanguage = localStorage.getItem('rainfoll-language') || this.detectBrowserLanguage();
        await this.loadLanguage(savedLanguage);
        this.setupLanguageToggle();
        this.updateLanguageDisplay();
    }

    detectBrowserLanguage() {
        const browserLang = navigator.language || navigator.userLanguage;
        const langCode = browserLang.split('-')[0];
        return this.supportedLanguages[langCode] ? langCode : this.fallbackLanguage;
    }

    async loadLanguage(lang) {
        if (!this.supportedLanguages[lang]) {
            lang = this.fallbackLanguage;
        }

        try {
            // Load translation file
            const response = await fetch(`assets/js/languages/${lang}.json`);
            if (response.ok) {
                this.translations[lang] = await response.json();
                this.currentLanguage = lang;
                localStorage.setItem('rainfoll-language', lang);
                this.updatePageContent();
                this.updateLanguageDisplay();
                document.documentElement.lang = lang;
                document.documentElement.dir = this.supportedLanguages[lang].dir;
            }
        } catch (error) {
            console.warn(`Failed to load language ${lang}:`, error);
            if (lang !== this.fallbackLanguage) {
                await this.loadLanguage(this.fallbackLanguage);
            }
        }
    }

    t(key, params = {}) {
        const translation = this.getNestedValue(this.translations[this.currentLanguage], key) ||
                          this.getNestedValue(this.translations[this.fallbackLanguage], key) ||
                          key;

        return this.interpolate(translation, params);
    }

    getNestedValue(obj, key) {
        return key.split('.').reduce((current, prop) => current && current[prop], obj);
    }

    interpolate(text, params) {
        if (typeof text !== 'string') return text;
        return text.replace(/\{\{(\w+)\}\}/g, (match, key) => params[key] || match);
    }

    updatePageContent() {
        // Update all elements with data-i18n attribute
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.t(key);
            
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                if (element.type === 'submit' || element.type === 'button') {
                    element.value = translation;
                } else {
                    element.placeholder = translation;
                }
            } else {
                element.textContent = translation;
            }
        });

        // Update elements with data-i18n-html attribute (for HTML content)
        document.querySelectorAll('[data-i18n-html]').forEach(element => {
            const key = element.getAttribute('data-i18n-html');
            element.innerHTML = this.t(key);
        });

        // Update elements with data-i18n-attr attribute
        document.querySelectorAll('[data-i18n-attr]').forEach(element => {
            const attrConfig = element.getAttribute('data-i18n-attr');
            const [attr, key] = attrConfig.split(':');
            element.setAttribute(attr, this.t(key));
        });

        // Update page title
        const titleKey = document.querySelector('meta[name="title-key"]');
        if (titleKey) {
            document.title = this.t(titleKey.content);
        }

        // Update meta description
        const descKey = document.querySelector('meta[name="desc-key"]');
        if (descKey) {
            document.querySelector('meta[name="description"]').content = this.t(descKey.content);
        }
    }

    setupLanguageToggle() {
        const toggle = document.getElementById('language-toggle');
        if (!toggle) return;

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showLanguageMenu();
        });

        // Close menu when clicking outside
        document.addEventListener('click', () => {
            this.hideLanguageMenu();
        });
    }

    showLanguageMenu() {
        const menu = document.getElementById('language-menu');
        if (menu) {
            menu.classList.remove('hidden');
        }
    }

    hideLanguageMenu() {
        const menu = document.getElementById('language-menu');
        if (menu) {
            menu.classList.add('hidden');
        }
    }

    async changeLanguage(lang) {
        if (lang !== this.currentLanguage) {
            await this.loadLanguage(lang);
            this.hideLanguageMenu();
        }
    }

    updateLanguageDisplay() {
        const currentDisplay = document.getElementById('current-language');
        if (currentDisplay) {
            const lang = this.supportedLanguages[this.currentLanguage];
            currentDisplay.innerHTML = `${lang.flag} ${lang.name}`;
        }

        // Update active state in menu
        document.querySelectorAll('[data-lang]').forEach(item => {
            const itemLang = item.getAttribute('data-lang');
            if (itemLang === this.currentLanguage) {
                item.classList.add('bg-brand-primary', 'text-white');
                item.classList.remove('text-gray-700', 'hover:bg-gray-100');
            } else {
                item.classList.remove('bg-brand-primary', 'text-white');
                item.classList.add('text-gray-700', 'hover:bg-gray-100');
            }
        });
    }

    createLanguageMenuHTML() {
        return Object.entries(this.supportedLanguages)
            .map(([code, info]) => `
                <button 
                    data-lang="${code}" 
                    onclick="localization.changeLanguage('${code}')"
                    class="w-full text-left px-4 py-2 text-sm flex items-center gap-3 transition-colors ${
                        code === this.currentLanguage 
                            ? 'bg-brand-primary text-white' 
                            : 'text-gray-700 hover:bg-gray-100'
                    }">
                    <span class="text-lg">${info.flag}</span>
                    <span>${info.name}</span>
                </button>
            `).join('');
    }
}

// Initialize localization when DOM is ready
let localization;
document.addEventListener('DOMContentLoaded', () => {
    localization = new LocalizationManager();
});

// Export for global access
window.localization = localization;
window.t = (key, params) => localization ? localization.t(key, params) : key;

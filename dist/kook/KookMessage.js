"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Paragraph = exports.KookText = exports.KookModule = exports.KookCardMessage = void 0;
class KookMessageBase {
    constructor(type) {
        this.type = type;
    }
}
class KookCardMessage extends KookMessageBase {
    constructor(modules = []) {
        super('card');
        this.theme = 'primary';
        this.size = 'lg';
        this.modules = [];
        this.modules = modules;
    }
}
exports.KookCardMessage = KookCardMessage;
class KookModule extends KookMessageBase {
    constructor(type, text = undefined) {
        super(type);
        this.text = text;
    }
}
exports.KookModule = KookModule;
class KookText extends KookMessageBase {
    constructor(type, content = '') {
        super(type);
        this.content = content;
    }
}
exports.KookText = KookText;
class Paragraph extends KookText {
    constructor() {
        super('paragraph', '');
        this.cols = 2;
        this.fields = [];
    }
}
exports.Paragraph = Paragraph;
//# sourceMappingURL=KookMessage.js.map
abstract class KookMessageBase {
  type: string;

  protected constructor(type: string) {
    this.type = type;
  }
}

export class KookCardMessage extends KookMessageBase {
  theme: string = 'primary';
  size: string = 'lg';
  modules: KookModule[] = [];

  constructor(modules: KookModule[] = []) {
    super('card');
    this.modules = modules;
  }
}

export class KookModule extends KookMessageBase {
  text: KookText | undefined;

  constructor(type: string, text: KookText | undefined = undefined) {
    super(type);
    this.text = text;
  }
}

export class KookText extends KookMessageBase {
  content: string;

  constructor(type: string, content: string = '') {
    super(type);
    this.content = content;
  }
}

export class Paragraph extends KookText {
  cols: number = 2;
  fields: KookText[] = [];

  constructor() {
    super('paragraph', '');
  }
}

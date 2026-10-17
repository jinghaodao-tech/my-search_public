"""Build demo/sample-paper.pdf: a short sample "paper" for the demo.

Original text written for the demo (no third-party content). It has a cover sheet,
printed page numbers 41-44 and a running head, so the demo can show how printed
pages are detected. Run: python3 scripts/demo/build_sample_pdf.py
"""
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
FONT = "HeiseiMin-W3"
W, H = A4
LEFT, RIGHT, TOP = 70, W - 70, H - 90
SIZE, LEADING = 10.5, 18
CHARS = int((RIGHT - LEFT) / SIZE)

PAGES = [
    [
        ("h", "1. はじめに"),
        ("p", "本稿は、調べ物の途中で得た知見を、あとから確かめられる形で残す方法を検討する見本の論文である。内容はデモのために書き下ろしたもので、実在の研究ではない。"),
        ("p", "調べ物では、読んだ内容そのものよりも、それをどこで読んだかという記録の方が先に失われる。記録が失われると、主張を確かめ直すことも、他人に示すこともできなくなる。"),
        ("h", "2. 記録に必要な要素"),
        ("p", "記録には少なくとも、出典の書誌情報、引用した文そのもの、その文が載っていたページ、そして記録した時点の日付が必要である。どれか一つが欠けると、あとからの確認に余計な手間がかかる。"),
    ],
    [
        ("p", "特にページは見落とされやすい。電子ファイルの何枚目かと、紙面に印刷されたページ番号は一致しないことが多く、表紙や前付けがある場合にはずれが生じる。引用で示すべきなのは印刷されたページである。"),
        ("h", "3. 先行する議論"),
        ("p", "見本(2020)は、記録の習慣について次のように述べている。"),
        ("p", "「読んだ直後に記録しなかった知見は、一週間後にはほとんど取り出せなくなる。」（見本 花子(2020), p.12）"),
        ("p", "ただし、ここでの引用は見本(2020)からのものであり、本稿の主張ではない。この一節をさらに引用する場合は、原典に当たる必要がある。"),
    ],
    [
        ("h", "4. 提案"),
        ("p", "本稿では、読みながら記録する作業を、引用・出典・ページの三つが自動的にそろう形に変えることを提案する。読み手は文を選ぶだけで、引用文とページと出典が一組になって保存される。"),
        ("p", "この方法の利点は、記録の手間が減ることだけではない。保存された引用が原文と一字一句一致しているかを、あとから機械的に確かめられる点にある。"),
        ("h", "5. 限界"),
        ("p", "文字情報を持たない画像だけの資料や、ページの概念がない電子書籍では、この方法はそのままでは使えない。"),
    ],
    [
        ("h", "6. おわりに"),
        ("p", "記録は、調べ物の結果を未来の自分や他人に手渡すための仕組みである。引用・出典・ページの三つをそろえることが、その最小限の条件になる。"),
        ("h", "参考文献"),
        ("p", "見本 花子 (2020)「記録の習慣」『見本紀要』1, pp. 10-20.（デモ用の架空の文献）"),
    ],
]


def wrap(text, width):
    return [text[i:i + width] for i in range(0, len(text), width)]


def main(out="demo/sample-paper.pdf"):
    c = canvas.Canvas(out, pagesize=A4)
    c.setTitle("sample-paper.pdf")
    c.setAuthor("")
    # cover sheet (no page number)
    c.setFont(FONT, 18)
    c.drawString(LEFT, H - 250, "調べ物の記録を確かめられる形で残す")
    c.setFont(FONT, 12)
    c.drawString(LEFT, H - 280, "―デモ用の見本論文―")
    c.drawString(LEFT, H - 330, "見本 太郎（デモ用の架空の著者）")
    c.drawString(LEFT, H - 360, "『見本紀要』3, pp. 41-44, 2025年")
    c.showPage()
    for n, blocks in enumerate(PAGES):
        c.setFont(FONT, 9)
        c.drawString(LEFT, H - 50, "見本紀要 第3号")
        y = TOP
        for kind, text in blocks:
            size = 12 if kind == "h" else SIZE
            c.setFont(FONT, size)
            lines = [text] if kind == "h" else wrap(text, CHARS)
            for i, line in enumerate(lines):
                x = LEFT + (SIZE if kind == "p" and i == 0 else 0)
                c.drawString(x, y, line)
                y -= LEADING
            y -= 6
        c.setFont(FONT, 10)
        c.drawCentredString(W / 2, 40, f"- {41 + n} -")
        c.showPage()
    c.save()


if __name__ == "__main__":
    main()

/**
 * comcigan-parser Module
 *
 * index.js
 *
 * Github : https://github.com/leegeunhyeok/comcigan-parser
 * NPM : https://www.npmjs.com/package/comcigan-parser
 *
 * @description 컴시간 시간표 파싱 라이브러리
 * @author Leegeunhyeok
 * @license MIT
 */

const request = require('request');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const HOST = 'http://컴시간학생.kr';

class Timetable {
  constructor() {
    this._baseUrl = null;
    this._url = null;
    this._pageSource = null;
    this._weekdayString = ['일', '월', '화', '수', '목', '금', '토'];
    this._option = {
      tempSave: false,
      maxGrade: 3,
    };
  }

  /**
   * 시간표 파서를 초기화합니다.
   *
   * @param option 초기화 옵션 객체
   */
  async init(option) {
    if (option) {
      this._option = Object.assign(this._option, option);
    }

    await new Promise((resolve, reject) => {
      request(HOST, (err, _res, body) => {
        if (err) {
          reject(err);
        }

        const frame = body
          .toLowerCase()
          .replace(/\'/g, '"')
          .match(/<frame [^>]*src="[^"]*"[^>]*>/gm);
        if (!frame) {
          reject(new Error('frame을 찾을 수 없습니다'));
          return;
        }

        const uri = frame[0].match(/\".*\"/gi);
        if (!uri) {
          reject(new Error('접근 주소를 찾을 수 없습니다'));
          return;
        }

        const frameHref = uri[0].replace(/\"/g, '');
        const url = new URL(frameHref);
        this._url = frameHref;
        this._baseUrl = url.origin;
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      request(
        {
          url: this._url,
          encoding: null,
        },
        (err, _res, body) => {
          if (err) {
            reject(err);
          }

          const source = iconv.decode(body, 'EUC-KR');
          const idx = source.indexOf('school_ra(sc)');
          const idx2 = source.indexOf("sc_data('");

          if (idx === -1 || idx2 === -1) {
            reject(new Error('소스에서 식별 코드를 찾을 수 없습니다.'));
            return;
          }

          const extractSchoolRa = source.substr(idx, 50).replace(' ', '');
          const schoolRa = extractSchoolRa.match(/url:'.(.*?)'/);

          // sc_data 인자값 추출
          const extractScData = source.substr(idx2, 30).replace(' ', '');
          const scData = extractScData.match(/\(.*?\)/);

          if (scData) {
            this._scData = scData[0]
              .replace(/[()]/g, '')
              .replace(/'/g, '')
              .split(',');
          } else {
            reject(new Error('sc_data 값을 찾을 수 없습니다.'));
            return;
          }

          if (schoolRa) {
            this._extractCode = schoolRa[1];
          } else {
            reject(new Error('school_ra 값을 찾을 수 없습니다.'));
            return;
          }

          this._pageSource = source;
          resolve();
        },
      );
    });
    this._initialized = true;
  }

  /**
   * 시간표 데이터를 불러올 학교를 설정합니다.
   *
   * @param {string} keyword 학교 검색 키워드
   */
  async setSchool(keyword) {
    if (!this._initialized) {
      throw new Error('초기화가 진행되지 않았습니다.');
    }

    let hexString = '';
    for (let buf of iconv.encode(keyword, 'euc-kr')) {
      hexString += '%' + buf.toString(16);
    }

    await new Promise((resolve, reject) => {
      request(
        this._baseUrl + this._extractCode + hexString,
        (err, _res, body) => {
          let jsonString = body.substr(0, body.lastIndexOf('}') + 1);
          let searchData = JSON.parse(jsonString)['학교검색'];

          if (err) {
            reject(err);
          }

          if (searchData.length <= 0) {
            reject(new Error('검색된 학교가 없습니다.'));
          }

          if (searchData.length > 1) {
            reject(
              new Error(
                `검색된 학교가 많습니다. 더 자세한 학교명을 입력해주세요. 검색 결과 수: ${searchData.length}`,
              ),
            );
          }

          this._searchData = searchData;
          resolve();
        },
      );
    });

    this._setSchool = true;
  }

  /**
   * 설정한 학교의 전교 시간표 데이터를 불러옵니다
   *
   * @return 시간표 데이터
   */
  async getTimetable() {
    if (!this._initialized) {
      throw new Error('초기화가 진행되지 않았습니다.');
    }

    if (!this._setSchool) {
      throw new Error('학교 설정이 진행되지 않았습니다.');
    }

    const da1 = '0';
    const s7 = this._scData[0] + this._searchData[0][3];
    const sc3 =
      this._extractCode.split('?')[0] +
      '?' +
      Buffer.from(s7 + '_' + da1 + '_' + this._scData[2]).toString('base64');

    // JSON 데이터 로드
    const jsonString = await new Promise((resolve, reject) => {
      request(this._baseUrl + sc3, (err, _ㄴres, body) => {
        if (err) {
          reject(err);
        }

        if (!body) {
          reject(new Error('시간표 데이터를 찾을 수 없습니다.'));
        }

        // String to JSON
        resolve(body.substr(0, body.lastIndexOf('}') + 1));
      });
    });

    const resultJson = JSON.parse(jsonString);
    const startTag = this._pageSource.match(/<script language(.*?)>/gm)[0];
    const regex = new RegExp(startTag + '(.*?)</script>', 'gi');

    let match;
    let script = '';
    // 컴시간 웹 페이지 JS 코드 추출
    while ((match = regex.exec(this._pageSource))) {
      script += match[1];
    }

    // 데이터 처리 함수명 추출
    const functioName = script
      .match(/function 자료[^\(]*/gm)[0]
      .replace(/\+s/, '')
      .replace('function', '');

    // 학년 별 전체 학급 수
    const classCount = resultJson['학급수'];

    // 저장 데이터 리스트
    let timetableData = {};

    // 1학년 ~ maxGrade 학년 교실 반복
    for (let grade = 1; grade <= this._option['maxGrade']; grade++) {
      if (!timetableData[grade]) {
        timetableData[grade] = {};
      }

      // 학년 별 반 수 만큼 반복
      for (let classNum = 1; classNum <= classCount[grade]; classNum++) {
        if (!timetableData[grade][classNum]) {
          timetableData[grade][classNum] = {};
        }

        timetableData[grade][classNum] = this._getClassTimetable(
          { data: jsonString, script, functioName },
          grade,
          classNum,
        );
      }
    }

    // 옵션 중 tempSave가 활성화 된 경우
    if (this._option.tempSave) {
      this._tempData = timetableData;
    }

    return timetableData;
  }

  /**
   * 지정된 학년/반의 1주일 시간표를 파싱합니다
   *
   * @param codeConfig 데이터, 함수명, 소스코드 객체
   * @param grade 학년
   * @param classNumber 반
   * @returns
   */
  _getClassTimetable(codeConfig, grade, classNumber) {
    const args = [codeConfig.data, grade, classNumber];
    const call = codeConfig.functioName + '(' + args.join(',') + ')';
    const script = codeConfig.script + '\n\n' + call;

    /** DEAD: Sorry about using eval() **/
    const res = eval(script);

    // Table HTML script
    const $ = cheerio.load(res);
    const $this = this;
    const timetable = [];
    $('tr').each(function (timeIdx) {
      const currentTime = timeIdx - 2;
      // 1, 2번째 tr은 제목 영역이므로 스킵
      if (timeIdx <= 1) return;

      $(this)
        .find('td')
        .each(function (weekDayIdx) {
          const currentWeekDay = weekDayIdx - 1;
          // 처음(제목)과 끝(토요일) 영역은 스킵
          if (weekDayIdx === 0 || weekDayIdx === 6) return;

          if (!timetable[currentWeekDay]) {
            timetable[currentWeekDay] = [];
          }

          const subject = $(this).contents().first().text();
          const teacher = $(this).contents().last().text();
          timetable[currentWeekDay][currentTime] = {
            grade,
            class: classNumber,
            weekday: weekDayIdx - 1,
            weekdayString: $this._weekdayString[weekDayIdx],
            classTime: currentTime + 1,
            teacher,
            subject,
          };
        });
    });

    return timetable;
  }

  /**
   * 임시 저장된 데이터를 반환합니다.
   *
   * @return 임시 저장된 데이터
   */
  getTempData() {
    return this._tempData || {};
  }
}

module.exports = Timetable;
